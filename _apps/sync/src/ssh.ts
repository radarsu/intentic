import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { baseDir, sshConfigPath, sshKeyPath } from "./config.js";

// Paths Mutagen syncs but shouldn't: machine-generated dirs + secret files (mirrors the daemon's ignore set).
// Passed to `mutagen sync create --ignore`; .git is covered by --ignore-vcs.
export const IGNORES = ["node_modules", "dist", ".turbo", ".cache", ".next", ".angular", ".env", ".secrets.json", "claude.json", "capabilities.json"];

// A sandbox id safe for an ssh-config alias / Mutagen session name (letters, digits, dashes).
export const sanitizeId = (raw: string): string => raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const sshAlias = (sandboxId: string): string => `intentic-sync-${sanitizeId(sandboxId)}`;

// The ssh-config stanza Mutagen's `ssh` uses to reach the sandbox: routed through the Cloudflare tunnel via
// cloudflared's ProxyCommand, authed by our dedicated key, with an isolated known_hosts so first-connect
// auto-accept can't be poisoned by (or poison) the user's global hosts file.
export const sshConfigBlock = (args: {
    readonly alias: string;
    readonly hostname: string;
    readonly identityFile: string;
    readonly knownHostsFile: string;
    readonly cloudflaredPath: string;
}): string =>
    [
        `Host ${args.alias}`,
        `    HostName ${args.hostname}`,
        "    User root",
        `    IdentityFile "${args.identityFile}"`,
        "    IdentitiesOnly yes",
        `    UserKnownHostsFile "${args.knownHostsFile}"`,
        "    StrictHostKeyChecking accept-new",
        // Paths are quoted: Windows profile paths often contain spaces (C:\Users\First Last\…).
        `    ProxyCommand "${args.cloudflaredPath}" access ssh --hostname %h`,
        "",
    ].join("\n");

export const INCLUDE_MARKER = `Include "${sshConfigPath}"`;

// Generate the ed25519 keypair on first setup; return the public key line to enroll on the daemon.
export const ensureSshKey = async (): Promise<string> => {
    await mkdir(baseDir, { recursive: true });
    const pub = `${sshKeyPath}.pub`;
    const existing = await readFile(pub, "utf8").catch(() => undefined);
    if (existing !== undefined) {
        return existing.trim();
    }
    const result = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "intentic-sync", "-f", sshKeyPath], { stdio: "inherit" });
    if (result.status !== 0) {
        throw new Error("ssh-keygen failed — is an OpenSSH client installed?");
    }
    return (await readFile(pub, "utf8")).trim();
};

// Write our managed ssh-config file and make the user's ~/.ssh/config Include it (once) so system `ssh` — and
// therefore Mutagen — resolves the alias. We never edit the user's own host entries, only prepend the Include.
export const writeManagedSshConfig = async (block: string): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(sshConfigPath, block, { mode: 0o600 });
    const userConfig = join(homedir(), ".ssh", "config");
    const current = await readFile(userConfig, "utf8").catch(() => "");
    if (current.includes(INCLUDE_MARKER)) {
        return;
    }
    await mkdir(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
    // Temp file + rename: a crash mid-write must never truncate the user's whole ssh config.
    const tmp = `${userConfig}.intentic-tmp`;
    await writeFile(tmp, `${INCLUDE_MARKER}\n${current}`, { mode: 0o600 });
    await rename(tmp, userConfig);
};
