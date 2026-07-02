import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { zoneFromPublicUrl } from "./zone.js";

// Local-sync (Mutagen) key enrollment. The owner's Google token authorizes POST /system/authorized-key, which
// lands their ed25519 public key here — so trust roots in Google, and Mutagen then rides SSH with that key.
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
