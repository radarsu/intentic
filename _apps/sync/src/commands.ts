import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { authorizeInteractive, idTokenFromRefresh } from "./auth.js";
import { knownHostsPath, readConfig, type SyncConfig, sshConfigPath, sshKeyPath, writeConfig, writeCredentials } from "./config.js";
import { ensureCloudflared, ensureMutagen, mutagenCreateArgs, runMutagen, sessionName } from "./mutagen.js";
import { ensureSshKey, sanitizeId, sshAlias, sshConfigBlock, writeManagedSshConfig } from "./ssh.js";

// Minimal daemon client for the two owner-gated setup calls, authed by the Google ID token (same trust root as
// the browser). Everything else is Mutagen over SSH.
const daemon = (sandboxUrl: string, idToken: string) => {
    const root = sandboxUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${idToken}` };
    return {
        enrollKey: async (key: string): Promise<void> => {
            const response = await fetch(`${root}/system/authorized-key`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ key }) });
            if (!response.ok) {
                throw new Error(`enrolling SSH key failed (${response.status}): ${await response.text()}`);
            }
        },
        sshHostname: async (): Promise<string> => {
            const response = await fetch(`${root}/system/sync`, { headers });
            if (!response.ok) {
                throw new Error(`reading sync info failed (${response.status}): ${await response.text()} — is the sandbox tunnel (with --ssh-service) up?`);
            }
            return ((await response.json()) as { sshHostname: string }).sshHostname;
        },
    };
};

interface SetupFlags {
    readonly sandboxUrl: string;
    readonly localDir: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly sandboxId?: string;
}

const setup = buildCommand<SetupFlags>({
    docs: { brief: "Authorize with Google, enroll an SSH key, and start a Mutagen sync of the local dir ↔ sandbox /work" },
    parameters: {
        flags: {
            sandboxUrl: { kind: "parsed", parse: String, brief: "The sandbox's public URL (e.g. https://sandbox-xxx.example.dev)" },
            localDir: { kind: "parsed", parse: String, brief: "Local directory to sync with the sandbox's /work" },
            clientId: { kind: "parsed", parse: String, brief: "Google desktop OAuth client id" },
            clientSecret: { kind: "parsed", parse: String, brief: "Google desktop OAuth client secret" },
            sandboxId: { kind: "parsed", parse: String, optional: true, brief: "Session/alias id (default: the sandbox URL host)" },
        },
    },
    async func(this: CommandContext, flags: SetupFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const refreshToken = await authorizeInteractive(flags.clientId, flags.clientSecret);
        await writeCredentials({ refreshToken });
        const idToken = await idTokenFromRefresh(flags.clientId, flags.clientSecret, refreshToken);

        const api = daemon(flags.sandboxUrl, idToken);
        const publicKey = await ensureSshKey();
        await api.enrollKey(publicKey);
        const sshHostname = await api.sshHostname();
        out(`enrolled SSH key; sandbox reachable at ${sshHostname}`);

        const sandboxId = flags.sandboxId ?? sanitizeId(new URL(flags.sandboxUrl).host);
        const cloudflaredPath = await ensureCloudflared();
        const mutagen = await ensureMutagen();
        await writeManagedSshConfig(
            sshConfigBlock({ alias: sshAlias(sandboxId), hostname: sshHostname, identityFile: sshKeyPath, knownHostsFile: knownHostsPath, cloudflaredPath }),
        );

        const config: SyncConfig = {
            sandboxUrl: flags.sandboxUrl,
            sandboxId,
            sshHostname,
            localDir: resolve(flags.localDir),
            googleClientId: flags.clientId,
            googleClientSecret: flags.clientSecret,
        };
        await writeConfig(config);

        runMutagen(mutagen, mutagenCreateArgs({ name: sessionName(sandboxId), localDir: config.localDir, alias: sshAlias(sandboxId), remoteDir: "/work" }));
        // Register the Mutagen daemon to autostart at login and resume sessions across reboots (its own native
        // mechanism — launchd/systemd/Task Scheduler). Best-effort: already-registered is not an error worth failing on.
        try {
            runMutagen(mutagen, ["daemon", "register"]);
        } catch (error) {
            out(`note: could not register the Mutagen daemon for autostart (${error instanceof Error ? error.message : String(error)}); it still runs while you're logged in.`);
        }
        out(`Sync started: ${config.localDir} ↔ ${sshHostname}:/work. Check it with \`intentic-sync status\`.`);
    },
});

const withMutagen = async (run: (mutagen: string, name: string) => void): Promise<void> => {
    const config = await readConfig();
    run(await ensureMutagen(), sessionName(config.sandboxId));
};

const status = buildCommand<Record<string, never>>({
    docs: { brief: "Show Mutagen sync status" },
    parameters: { flags: {} },
    async func() {
        runMutagen(await ensureMutagen(), ["sync", "list"]);
    },
});

const pause = buildCommand<Record<string, never>>({
    docs: { brief: "Pause syncing" },
    parameters: { flags: {} },
    async func() {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "pause", name]));
    },
});

const resume = buildCommand<Record<string, never>>({
    docs: { brief: "Resume syncing" },
    parameters: { flags: {} },
    async func() {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "resume", name]));
    },
});

const uninstall = buildCommand<Record<string, never>>({
    docs: { brief: "Terminate the sync session and remove the managed ssh-config include" },
    parameters: { flags: {} },
    async func(this: CommandContext) {
        await withMutagen((mutagen, name) => runMutagen(mutagen, ["sync", "terminate", name]));
        const userConfig = join(homedir(), ".ssh", "config");
        const current = await readFile(userConfig, "utf8").catch(() => "");
        const stripped = current
            .split("\n")
            .filter((line) => line.trim() !== `Include ${sshConfigPath}`)
            .join("\n");
        if (stripped !== current) {
            await writeFile(userConfig, stripped, { mode: 0o600 });
        }
        this.process.stdout.write("Sync terminated; ssh-config include removed. (The Mutagen daemon stays registered — `mutagen daemon unregister` to remove it.)\n");
    },
});

export const commands = { setup, status, pause, resume, uninstall };
