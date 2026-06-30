import { describe, expect, test } from "vitest";
import { createAuthorizer, type IdTokenVerifier, type OwnerStore } from "./auth.js";

// In-memory owner store so the TOFU branching is exercised without touching disk.
const memOwner = (initial?: string): OwnerStore => {
    let value = initial;
    return {
        read: async () => value,
        write: async (email) => {
            value = email;
        },
    };
};

// A fake verifier mapping a token straight to an email; an unknown token throws, standing in for a failed
// JWKS/issuer/audience verification.
const verifierFor =
    (map: Record<string, string>): IdTokenVerifier =>
    async (token) => {
        const email = map[token];
        if (email === undefined) {
            throw new Error("invalid token");
        }
        return { email };
    };

describe("createAuthorizer (owner TOFU)", () => {
    test("binds the first authenticated email as owner, then accepts only that owner", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com", "tok-b": "b@x.com" }), owner });
        await authz.authorize("tok-a", undefined);
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toBeUndefined();
        await expect(authz.authorize("tok-b", undefined)).rejects.toThrow(/not the sandbox owner/);
    });

    test("rejects a missing bearer", async () => {
        const authz = createAuthorizer({ verify: verifierFor({}), owner: memOwner() });
        await expect(authz.authorize("", undefined)).rejects.toThrow(/missing bearer/);
    });

    test("propagates a verify failure (invalid/expired/wrong-audience token)", async () => {
        const authz = createAuthorizer({ verify: verifierFor({ good: "a@x.com" }), owner: memOwner() });
        await expect(authz.authorize("bogus", undefined)).rejects.toThrow(/invalid token/);
    });

    test("with a connectToken, first-bind requires it; later requests do not", async () => {
        const owner = memOwner();
        const authz = createAuthorizer({ verify: verifierFor({ "tok-a": "a@x.com" }), owner, connectToken: "secret" });
        await expect(authz.authorize("tok-a", undefined)).rejects.toThrow(/connection token/);
        await expect(authz.authorize("tok-a", "wrong")).rejects.toThrow(/connection token/);
        expect(await owner.read()).toBeUndefined();
        await authz.authorize("tok-a", "secret");
        expect(await owner.read()).toBe("a@x.com");
        await expect(authz.authorize("tok-a", undefined)).resolves.toBeUndefined();
    });
});
