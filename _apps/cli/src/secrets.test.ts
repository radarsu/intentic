import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesiredStateGraph } from "@intentic/graph";
import { describe, expect, it } from "vitest";
import { collectSecrets, writeEnvExample } from "./secrets.js";

const node = (id: string, inputs: Record<string, unknown>) => ({ id, type: "x", inputs, dependsOn: [] });
const env = (key: string) => ({ $secret: { source: "env" as const, key } });
const gen = (key: string) => ({ $secret: { source: "generated" as const, key } });

const graph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: node("host", { sshKey: env("HOST_SSH_KEY"), address: "203.0.113.10" }),
        // A nested env secret (inside an env map) and a $ref that must be ignored.
        app: node("app", { server: { $ref: "host" }, env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } }),
        // Generated secrets, plus a duplicate key (also used elsewhere) that must collapse to one entry.
        forgejo: node("forgejo", { adminPassword: gen("FORGEJO_ADMIN_PASSWORD") }),
        deploy: node("deploy", { sshKey: env("HOST_SSH_KEY"), pw: gen("KOMODO_ADMIN_PASSWORD") }),
    },
};

describe("collectSecrets", () => {
    it("walks nested inputs and splits into sorted, de-duplicated env/generated buckets", () => {
        expect(collectSecrets(graph)).toEqual({
            env: ["HOST_SSH_KEY", "PRODUCTION_DATABASE_URL"],
            generated: ["FORGEJO_ADMIN_PASSWORD", "KOMODO_ADMIN_PASSWORD"],
        });
    });

    it("throws when one key is declared under both sources (a resolver bug)", () => {
        const conflict: DesiredStateGraph = {
            version: 1,
            resources: { a: node("a", { x: env("DUP") }), b: node("b", { y: gen("DUP") }) },
        };
        expect(() => collectSecrets(conflict)).toThrow(/both/);
    });
});

describe("writeEnvExample", () => {
    it("writes one KEY= line per secret under a header", async () => {
        const dir = await mkdtemp(join(tmpdir(), "intentic-secrets-"));
        const path = join(dir, ".env.example");
        await writeEnvExample(path, ["HOST_SSH_KEY", "CLOUDFLARE_API_TOKEN"]);

        const content = await readFile(path, "utf8");
        expect(content).toContain("HOST_SSH_KEY=");
        expect(content).toContain("CLOUDFLARE_API_TOKEN=");
        expect(content.startsWith("#")).toBe(true);
    });
});
