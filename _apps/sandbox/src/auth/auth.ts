import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

// The sandbox authenticates the END USER directly against Google — the platform never holds or signs this
// credential, so a platform compromise can't command the sandbox. The browser obtains a Google ID token via
// Google Identity Services and presents it as a bearer; we verify its signature against Google's published
// JWKS and its issuer/audience. The audience is our Google *web* client id (public, not a secret).
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface VerifiedIdentity {
    readonly email: string;
}

// Verifies a Google ID token and returns its verified email; throws if the signature, issuer, audience, or
// email verification fail. Implemented over Google's remote JWKS (jose caches the keys).
export type IdTokenVerifier = (idToken: string) => Promise<VerifiedIdentity>;

// `audience` accepts more than one client id so a single owner can present tokens minted by different Google
// OAuth clients — the browser's *web* client and the local sync agent's *desktop* client — against the same
// sandbox. Ownership is still by verified email; only the accepted `aud` set widens.
export const createGoogleVerifier = (audience: string | readonly string[]): IdTokenVerifier => {
    const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    return async (idToken) => {
        const { payload } = await jwtVerify(idToken, jwks, { issuer: GOOGLE_ISSUERS, audience: audience as string | string[] });
        const email = payload["email"];
        if (typeof email !== "string" || payload["email_verified"] !== true) {
            throw new Error("google id token has no verified email");
        }
        return { email };
    };
};

// Persists the sandbox's single owner email (trust-on-first-use). Defaults to a JSON file beside the
// workspace (the same .intentic/ dir as the claude/tools stores); injected in tests.
export interface OwnerStore {
    read(): Promise<string | undefined>;
    write(email: string): Promise<void>;
}

export const fileOwnerStore = (path: string): OwnerStore => ({
    read: async () => {
        try {
            const parsed = JSON.parse(await readFile(path, "utf8")) as { email?: unknown };
            return typeof parsed.email === "string" ? parsed.email : undefined;
        } catch {
            return undefined;
        }
    },
    write: async (email) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ email }), "utf8");
    },
});

// The additional authorized emails (shared access beyond the owner), stored as { emails: [...] } in the same
// .intentic/ dir. The owner is NOT listed here — ownership stays in the owner store. The daemon is the real
// enforcer of shared access; the platform only mirrors these grants so a member's browser can find the sandbox.
export interface MembersStore {
    list(): Promise<string[]>;
    add(email: string): Promise<void>;
    remove(email: string): Promise<void>;
}

const readEmails = async (path: string): Promise<string[]> => {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { emails?: unknown };
        return Array.isArray(parsed.emails) ? parsed.emails.filter((email): email is string => typeof email === "string") : [];
    } catch {
        return [];
    }
};

export const fileMembersStore = (path: string): MembersStore => ({
    list: () => readEmails(path),
    add: async (email) => {
        const emails = await readEmails(path);
        if (emails.includes(email)) {
            return;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ emails: [...emails, email] }), "utf8");
    },
    remove: async (email) => {
        const emails = await readEmails(path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({ emails: emails.filter((member) => member !== email) }), "utf8");
    },
});

export const tokenEquals = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

export interface Authorizer {
    // Verify a request's bearer Google ID token and enforce access. The FIRST authenticated request binds its
    // email as the owner (TOFU); when a connectToken is configured, that first request must also carry it (the
    // connection token only the operator holds — closes the first-bind race). Every later request must be the
    // owner OR a granted member. Throws on any failure; the daemon maps a throw to 401.
    authorize(bearer: string, firstBind: string | undefined): Promise<void>;
    // Verify the bearer AND assert the caller is the bound owner (not merely a member) — the gate for the
    // owner-only member-management routes. Throws on any failure.
    authorizeOwner(bearer: string): Promise<void>;
}

export const createAuthorizer = (deps: {
    readonly verify: IdTokenVerifier;
    readonly owner: OwnerStore;
    readonly members: MembersStore;
    readonly connectToken?: string;
}): Authorizer => ({
    authorize: async (bearer, firstBind) => {
        if (bearer === "") {
            throw new Error("missing bearer token");
        }
        const { email } = await deps.verify(bearer);
        const owner = await deps.owner.read();
        if (owner === undefined) {
            if (deps.connectToken !== undefined && (firstBind === undefined || !tokenEquals(firstBind, deps.connectToken))) {
                throw new Error("first-bind requires the connection token");
            }
            await deps.owner.write(email);
            return;
        }
        if (email === owner) {
            return;
        }
        if (!(await deps.members.list()).includes(email)) {
            throw new Error("not authorized for this sandbox");
        }
    },
    authorizeOwner: async (bearer) => {
        if (bearer === "") {
            throw new Error("missing bearer token");
        }
        const { email } = await deps.verify(bearer);
        if (email !== (await deps.owner.read())) {
            throw new Error("not the sandbox owner");
        }
    },
});
