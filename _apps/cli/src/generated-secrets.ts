import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SECRETS_FILE } from "./artifact.js";

type MutableEnv = Record<string, string | undefined>;

// Shell-safe hex (the value is interpolated UNQUOTED into `docker exec … --password` and the Komodo host
// `.env` echo), 128 bits — matching demo.ts's randomBytes(16).toString("hex").
const generate = (): string => randomBytes(16).toString("hex");

// Ensure every intentic-generated secret has a value, persisting to `<dir>/.secrets.json` (gitignored) so it
// is generated ONCE and reused forever after: Forgejo/Komodo bake the admin password in on first init and
// will not re-key, so regenerating would lock us out. An explicitly-set env value wins (the user pinned it)
// and is left untouched — never copied into the store. Resolved values are written into `env` so the engine
// resolves them like any secret.
export const ensureGeneratedSecrets = async (dir: string, keys: readonly string[], env: MutableEnv): Promise<void> => {
    if (keys.length === 0) {
        return;
    }
    const path = join(dir, SECRETS_FILE);
    const store: Record<string, string> = existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
    let dirty = false;
    for (const key of keys) {
        if (env[key]) {
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
