import { expect, test } from "vitest";
import { envKeys, upsertEnv } from "./secrets.routes.js";

test("upsertEnv appends a new key, updates an existing one, and leaves the rest untouched", () => {
    let env = upsertEnv("", "CLOUDFLARE_API_TOKEN", "cf1");
    expect(env).toBe("CLOUDFLARE_API_TOKEN=cf1\n");
    env = upsertEnv(env, "GITHUB_TOKEN", "gh1");
    expect(env).toBe("CLOUDFLARE_API_TOKEN=cf1\nGITHUB_TOKEN=gh1\n");
    // Re-setting an existing key edits it in place (no duplicate line).
    env = upsertEnv(env, "CLOUDFLARE_API_TOKEN", "cf2");
    expect(env).toBe("CLOUDFLARE_API_TOKEN=cf2\nGITHUB_TOKEN=gh1\n");
});

test("envKeys returns keys only (never values), skipping blanks and comments", () => {
    expect(envKeys("# a comment\nCLOUDFLARE_API_TOKEN=secret\n\nPROD_SSH_KEY=----\n")).toEqual(["CLOUDFLARE_API_TOKEN", "PROD_SSH_KEY"]);
});
