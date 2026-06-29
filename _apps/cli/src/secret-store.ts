import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SshExecutor, SshTarget } from "@intentic/providers";
import { SECRETS_FILE } from "./artifact.js";

// A key→value store for intentic's generated secrets (the Forgejo/Komodo admin passwords). Storage only,
// mirroring HostKeyStore: env-first precedence and minting are policy, and live in ensureGeneratedSecrets — so
// the same policy runs over any backend. The local backend below is the laptop-local cache; a host-backed
// backend makes the authoritative copy shared across operators instead of local to whoever bootstrapped.
export interface SecretStore {
    readonly get: (key: string) => Promise<string | undefined>;
    readonly set: (key: string, value: string) => Promise<void>;
}

// The local backend: the gitignored .secrets.json beside the artifact (mode 0o600, 4-space JSON, trailing
// newline — the same on-disk conventions as .known-hosts.json). `set` is read-modify-write.
export const createLocalSecretStore = (dir: string): SecretStore => {
    const path = join(dir, SECRETS_FILE);
    const read = async (): Promise<Record<string, string>> =>
        existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
    return {
        get: async (key) => (await read())[key],
        set: async (key, value) => {
            const store = await read();
            store[key] = value;
            await writeFile(path, `${JSON.stringify(store, undefined, 4)}\n`, { mode: 0o600 });
        },
    };
};

// The control-plane host is the authoritative home for generated secrets (the Forgejo/Komodo admin passwords),
// so every operator reads the SAME value instead of minting its own from a laptop-local cache. Stored at
// /opt/intentic/secrets.json (mode 0600, root-only), the same writable convention the backing providers use.
// A per-instance cache makes one read serve a whole ensure() pass; writes are read-modify-write of that cache.
const HOST_SECRETS_PATH = "/opt/intentic/secrets.json";
export const createHostSecretStore = (target: SshTarget, executor: SshExecutor): SecretStore => {
    let cache: Record<string, string> | undefined;
    const load = async (): Promise<Record<string, string>> => {
        if (cache !== undefined) {
            return cache;
        }
        const session = await executor.connect(target);
        try {
            const result = await session.exec(`cat ${HOST_SECRETS_PATH} 2>/dev/null || echo '{}'`);
            cache = JSON.parse(result.stdout.trim() || "{}") as Record<string, string>;
        } finally {
            await session.dispose();
        }
        return cache;
    };
    return {
        get: async (key) => (await load())[key],
        set: async (key, value) => {
            const store = await load();
            store[key] = value;
            const json = JSON.stringify(store, undefined, 4);
            const session = await executor.connect(target);
            try {
                // Heredoc with a QUOTED delimiter writes the JSON body verbatim (no shell expansion — safe for
                // arbitrary content); write to a temp file then mv so a concurrent reader never sees a partial file.
                await session.exec(
                    `mkdir -p /opt/intentic && cat > ${HOST_SECRETS_PATH}.tmp <<'INTENTIC_SECRETS_EOF'\n${json}\nINTENTIC_SECRETS_EOF\nchmod 600 ${HOST_SECRETS_PATH}.tmp && mv ${HOST_SECRETS_PATH}.tmp ${HOST_SECRETS_PATH}`,
                );
            } finally {
                await session.dispose();
            }
        },
    };
};

// Compose stores into a precedence chain (most-authoritative first, e.g. [host, local]). `get` returns the
// first defined value; with `backfill` on, it then reconciles every other layer to that value — so a secret
// minted into the local cache before the host existed is promoted to the host, and an operator who never
// bootstrapped has the host value mirrored back into their local cache for offline tooling. `backfill` is off
// for read-only commands (plan) so they never mutate a store. `set` writes every layer (mint persists to all).
export const createLayeredSecretStore = (
    layers: readonly SecretStore[],
    options: { readonly backfill: boolean; readonly log?: (message: string) => void },
): SecretStore => {
    const log = options.log ?? (() => {});
    return {
        get: async (key) => {
            const values: (string | undefined)[] = [];
            for (const layer of layers) {
                try {
                    values.push(await layer.get(key));
                } catch (error) {
                    log(`secret-store: a layer's read of "${key}" failed, skipping it: ${String(error)}`);
                    values.push(undefined);
                }
            }
            const result = values.find((value) => value !== undefined);
            if (result !== undefined && options.backfill) {
                for (const [i, layer] of layers.entries()) {
                    if (values[i] === result) {
                        continue;
                    }
                    try {
                        await layer.set(key, result);
                    } catch (error) {
                        log(`secret-store: failed to backfill "${key}" into a layer: ${String(error)}`);
                    }
                }
            }
            return result;
        },
        set: async (key, value) => {
            let persisted = false;
            for (const layer of layers) {
                try {
                    await layer.set(key, value);
                    persisted = true;
                } catch (error) {
                    log(`secret-store: a layer's write of "${key}" failed: ${String(error)}`);
                }
            }
            if (!persisted) {
                throw new Error(`failed to persist generated secret "${key}" to any store`);
            }
        },
    };
};
