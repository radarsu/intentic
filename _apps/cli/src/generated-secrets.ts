import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRETS_FILE } from "./artifact.js";

type MutableEnv = Record<string, string | undefined>;

// Shell-safe hex (the value is interpolated UNQUOTED into `docker exec … --password` and the Komodo host
// `.env` echo), 128 bits — matching demo.ts's randomBytes(16).toString("hex").
const generate = (): string => randomBytes(16).toString("hex");

const secretsPath = (dir: string): string => join(dir, SECRETS_FILE);

const readStore = async (path: string): Promise<Record<string, string>> =>
    existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};

// Ensure every intentic-generated secret has a value. Precedence is ENV-FIRST: an already-set `env[key]` is
// authoritative and neither reads nor writes `.secrets.json`. This is what lets the apply pipeline run inside
// Forgejo — it injects the generated secrets (Forgejo/Komodo admin passwords) from Forgejo Actions secrets,
// where `.secrets.json` does not exist; without env-first, a missing file would mint NEW passwords and lock us
// out (Forgejo/Komodo bake the password in on first init and will not re-key). When env is unset (local
// bootstrap) the value is read from `<dir>/.secrets.json` (gitignored), generated + persisted there ONCE and
// reused forever. The engine then resolves them from `env` like any secret.
export const ensureGeneratedSecrets = async (dir: string, keys: readonly string[], env: MutableEnv): Promise<void> => {
    if (keys.length === 0) {
        return;
    }
    const path = secretsPath(dir);
    const store = await readStore(path);
    let dirty = false;
    for (const key of keys) {
        if (env[key] !== undefined && env[key] !== "") {
            continue;
        }
        if (store[key] === undefined) {
            store[key] = generate();
            dirty = true;
        }
        env[key] = store[key];
    }
    if (dirty) {
        await writeFile(path, `${JSON.stringify(store, undefined, 4)}\n`, { mode: 0o600 });
    }
};

// Read the generated secrets back (or `{}` if none yet) — for tools that drive the CLI and then need the
// values, e.g. the demo/e2e signing into the Forgejo/Komodo they just provisioned.
export const readGeneratedSecrets = (dir: string): Promise<Record<string, string>> => readStore(secretsPath(dir));
