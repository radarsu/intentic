import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Everything the agent persists lives under ~/.intentic/sync — the config it was set up with, the OAuth refresh
// token, the SSH keypair Mutagen authenticates with, and the ssh config/known_hosts Mutagen's ssh reads.
export const baseDir = join(homedir(), ".intentic", "sync");
export const configPath = join(baseDir, "config.json");
export const credentialsPath = join(baseDir, "credentials.json");
export const sshKeyPath = join(baseDir, "id_ed25519");
export const sshConfigPath = join(baseDir, "ssh_config");
export const knownHostsPath = join(baseDir, "known_hosts");
export const binDir = join(baseDir, "bin");

// What `intentic-sync setup` writes and the other commands read back. The Google client id/secret are a
// *desktop* OAuth client (the secret is not confidential for installed apps); the daemon accepts the id as a
// token audience. sshHostname is what the daemon's /system/sync returned — the tunnel host Mutagen reaches.
export interface SyncConfig {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly sshHostname: string;
    readonly localDir: string;
    readonly googleClientId: string;
    readonly googleClientSecret: string;
}

export interface StoredCredentials {
    readonly refreshToken: string;
}

// The platform-owned Google *Desktop* OAuth client the sync agent signs in with, so users never create their
// own — the daemon accepts its id as a token audience (google.syncClientId). Installed-app client secrets are
// NOT confidential (Google's own guidance), so baking one here is fine; env overrides for a self-hosted platform.
// ponytail: placeholder credential — provision the platform desktop client and fill these before release.
export const platformGoogleDesktopClientId =
    process.env["GOOGLE_SYNC_CLIENT_ID"] ?? "481795963975-pnobq9vv98c2enbdf2hi1r8jdfkocalr.apps.googleusercontent.com";
export const platformGoogleDesktopClientSecret = process.env["GOOGLE_SYNC_CLIENT_SECRET"] ?? "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";

export const readConfig = async (): Promise<SyncConfig> => JSON.parse(await readFile(configPath, "utf8")) as SyncConfig;

export const writeConfig = async (config: SyncConfig): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, undefined, 2), "utf8");
};

export const readCredentials = async (): Promise<StoredCredentials | undefined> => {
    try {
        return JSON.parse(await readFile(credentialsPath, "utf8")) as StoredCredentials;
    } catch {
        return undefined;
    }
};

// The refresh token is the long-lived secret — write it 0600 so other users on the machine can't read it.
// ponytail: file perms, not the OS keychain — swap in keytar if a shared-machine threat model demands it.
export const writeCredentials = async (credentials: StoredCredentials): Promise<void> => {
    await mkdir(dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });
};
