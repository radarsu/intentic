import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zoneFromPublicUrl } from "./zone.js";

// Local-sync (Mutagen) enrollment. The owner mints a short-lived pairing token in the browser (POST
// /system/sync/pair, Google-authed); the desktop agent redeems it once at POST /system/authorized-key to land
// its ed25519 public key here, then Mutagen rides SSH with that key. So trust still roots in the owner's Google
// identity (which mints the token), but the agent itself needs no OAuth — just the one-time token.

// One-time pairing tokens, in memory (ephemeral: a daemon restart just means the user clicks Enable again).
const PAIR_TTL_MS = 10 * 60 * 1000;
const pairings = new Map<string, { expiresAt: number }>();

export const mintPairing = (): { token: string; expiresIn: number } => {
    const token = randomBytes(32).toString("base64url");
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS });
    return { token, expiresIn: Math.floor(PAIR_TTL_MS / 1000) };
};

// Seed a pre-agreed pairing: the platform-minted setup-time token connect.{sh,ps1} passes via container env
// (SYNC_PAIR_TOKEN), so the connect script's sync agent can enroll without a browser mint. Same TTL + single-use
// consumption as a minted one. The env persists on the container, so each restart re-arms it for PAIR_TTL_MS —
// same trust class as CONNECT_TOKEN sitting in the same env.
export const seedPairing = (token: string): void => {
    pairings.set(token, { expiresAt: Date.now() + PAIR_TTL_MS });
};

// Valid = known + unexpired (prunes on expiry). Peek only — the caller consumes it after a successful enroll,
// so a failed enroll leaves the token usable for a retry.
export const isValidPairing = (token: string): boolean => {
    const pairing = pairings.get(token);
    if (pairing === undefined) {
        return false;
    }
    if (pairing.expiresAt < Date.now()) {
        pairings.delete(token);
        return false;
    }
    return true;
};

export const consumePairing = (token: string): void => {
    pairings.delete(token);
};

const authorizedKeysPath = (): string => join(homedir(), ".ssh", "authorized_keys");

// One well-formed public key line: a known type, a base64 blob, an optional comment, and no embedded newline
// (so a caller can't smuggle extra authorized_keys entries or sshd directives).
const KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( \S+)?$/;

export const isValidAuthorizedKey = (key: string): boolean => !key.includes("\n") && KEY_LINE.test(key.trim());

export const enrollAuthorizedKey = async (key: string): Promise<void> => {
    const line = key.trim();
    const path = authorizedKeysPath();
    const existing = await readFile(path, "utf8").catch(() => "");
    if (existing.split("\n").some((entry) => entry.trim() === line)) {
        return;
    }
    await mkdir(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
    await appendFile(path, `${line}\n`, { mode: 0o600 });
};

// Whether a desktop-sync key is enrolled — the UI's "desktop sync enabled" signal (≥1 non-blank key line).
export const isKeyEnrolled = async (): Promise<boolean> => {
    const existing = await readFile(authorizedKeysPath(), "utf8").catch(() => "");
    return existing.split("\n").some((entry) => entry.trim().length > 0);
};

// Revoke desktop sync: drop all enrolled keys (the UI's Disable). Removing the key halts Mutagen's SSH transport.
export const clearAuthorizedKeys = async (): Promise<void> => {
    await writeFile(authorizedKeysPath(), "", { mode: 0o600 }).catch(() => {});
};

// The SSH hostname the sandbox tunnel exposes for Mutagen — derived exactly as sandbox-tunnel.ts derives the
// HTTP host (id = sha256(connectToken)[:12]), so the laptop can resolve it from the daemon without guessing.
// Undefined when the tunnel isn't configured (no connect token / no zone) — e.g. loopback or preview-only.
export const syncSshHostname = (connectToken: string, zone: string, publicUrl: string): string | undefined => {
    const resolvedZone = zone !== "" ? zone : zoneFromPublicUrl(publicUrl);
    if (connectToken === "" || resolvedZone === undefined || resolvedZone === "") {
        return undefined;
    }
    return `ssh-${createHash("sha256").update(connectToken).digest("hex").slice(0, 12)}.${resolvedZone}`;
};
