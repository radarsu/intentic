import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Everything the agent persists lives under ~/.intentic/sync — the config it was set up with, the OAuth refresh
// token, and one manifest dir per sandbox. Kept in the user's home (not the mirror dir) so nothing sync state
// leaks into the folder being mirrored.
export const baseDir = join(homedir(), ".intentic", "sync");
export const configPath = join(baseDir, "config.json");
export const credentialsPath = join(baseDir, "credentials.json");
export const manifestPath = (sandboxId: string): string => join(baseDir, sandboxId, "manifest.json");

// What `intentic-sync setup` writes and `run` reads back. The Google client id/secret are a *desktop* OAuth
// client (the secret is not confidential for installed apps — Google says so); the daemon accepts the client id
// as a token audience. sandboxId namespaces the manifest so one machine can mirror several sandboxes.
export interface SyncConfig {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly localDir: string;
    readonly googleClientId: string;
    readonly googleClientSecret: string;
}

export interface StoredCredentials {
    readonly refreshToken: string;
}

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
