import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGeneratedSecrets } from "./generated-secrets.js";

const newDir = () => mkdtemp(join(tmpdir(), "intentic-gen-"));
const secretsPath = (dir: string) => join(dir, ".secrets.json");

describe("ensureGeneratedSecrets", () => {
    it("generates shell-safe hex values, persists them, and sets them into env", async () => {
        const dir = await newDir();
        const env: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(dir, ["FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD"], env);

        expect(env["FORGEJO_ADMIN_PASSWORD"]).toMatch(/^[0-9a-f]{32}$/);
        expect(env["KOMODO_ADMIN_PASSWORD"]).toMatch(/^[0-9a-f]{32}$/);
        expect(JSON.parse(await readFile(secretsPath(dir), "utf8"))).toEqual({
            FORGEJO_ADMIN_PASSWORD: env["FORGEJO_ADMIN_PASSWORD"],
            KOMODO_ADMIN_PASSWORD: env["KOMODO_ADMIN_PASSWORD"],
        });
    });

    it("reuses persisted values across calls (generate once, never re-key)", async () => {
        const dir = await newDir();
        const first: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(dir, ["FORGEJO_ADMIN_PASSWORD"], first);
        const stored = await readFile(secretsPath(dir), "utf8");

        const second: Record<string, string | undefined> = {};
        await ensureGeneratedSecrets(dir, ["FORGEJO_ADMIN_PASSWORD"], second);

        expect(second["FORGEJO_ADMIN_PASSWORD"]).toBe(first["FORGEJO_ADMIN_PASSWORD"]);
        expect(await readFile(secretsPath(dir), "utf8")).toBe(stored);
    });

    it("lets an explicitly-set env value win and never persists it", async () => {
        const dir = await newDir();
        const env: Record<string, string | undefined> = { FORGEJO_ADMIN_PASSWORD: "pinned-by-user" };
        await ensureGeneratedSecrets(dir, ["FORGEJO_ADMIN_PASSWORD"], env);

        expect(env["FORGEJO_ADMIN_PASSWORD"]).toBe("pinned-by-user");
        expect(existsSync(secretsPath(dir))).toBe(false);
    });

    it("is a no-op when there are no generated keys", async () => {
        const dir = await newDir();
        await ensureGeneratedSecrets(dir, [], {});
        expect(existsSync(secretsPath(dir))).toBe(false);
    });
});
