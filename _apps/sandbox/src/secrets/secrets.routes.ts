import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { secretsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

const ENV_FILE = ".env";

// Upsert KEY=value into a .env's text: replace the line if the key exists, else append; always end with a
// newline. Pure so it's unit-tested without the fs. Secrets are single-line tokens/keys (the key shape is
// validated at the contract; a multi-line value is out of scope).
export const upsertEnv = (content: string, key: string, value: string): string => {
    const lines = content.length === 0 ? [] : content.replace(/\n$/, "").split("\n");
    const line = `${key}=${value}`;
    const index = lines.findIndex((existing) => existing.startsWith(`${key}=`));
    if (index === -1) {
        lines.push(line);
    } else {
        lines[index] = line;
    }
    return `${lines.join("\n")}\n`;
};

// The KEYS present in a .env's text (for the UI's "✓ set" badges) — never the values. Skips blanks/comments.
export const envKeys = (content: string): string[] =>
    content
        .split("\n")
        .map((raw) => raw.trim())
        .filter((raw) => raw.length > 0 && !raw.startsWith("#") && raw.includes("="))
        .map((raw) => raw.slice(0, raw.indexOf("=")));

// User-supplied secrets → repositories/desired-state/.env (gitignored, on the file denylist, mode 0600). Written
// straight from the browser to the daemon (never the platform); `apply` reloads .env each run so a freshly set
// secret is picked up with no restart. Refuses until DevOps has scaffolded the desired-state repo.
export const createSecretsRoutes = (services: Services) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const envPath = (): string => join(services.workspace.repos["desired-state"], ENV_FILE);
    const ensureActive = (): void => {
        if (!existsSync(services.workspace.repos["desired-state"])) {
            throw new ORPCError("PRECONDITION_FAILED", { message: "DevOps is not active — activate it before adding secrets." });
        }
    };
    const read = async (): Promise<string> => {
        try {
            return await readFile(envPath(), "utf8");
        } catch {
            return "";
        }
    };
    return {
        set: i.set.handler(async ({ input }) => {
            ensureActive();
            const path = envPath();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, upsertEnv(await read(), input.key, input.value), { mode: 0o600 });
            return { ok: true } as const;
        }),
        list: i.list.handler(async () => {
            ensureActive();
            return { keys: envKeys(await read()) };
        }),
    };
};
