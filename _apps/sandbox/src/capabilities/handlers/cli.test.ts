import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../capability.js";
import { cliEnvOf } from "../cli-env.js";
import { cliProviders } from "../cli/providers.js";
import { cliHandler } from "./cli.js";

// A ctx exposing only what cliHandler touches (files + workspace.root), over a fresh temp workspace.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "cli-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "tok-123" } };
const skillPath = (root: string): string => join(root, ".claude", "skills", "discord", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply writes the provider's SKILL.md; status flips inactive -> active", async () => {
    const { ctx, root } = tempCtx();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });

    await drain(cliHandler.apply(ctx, "discord", discord.config));

    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: discord");
    expect(skill).toContain("$DISCORD_BOT_TOKEN");
    expect(skill).toContain("https://discord.com/api/v10/channels/<CHANNEL_ID>/messages");
    // The guided-invite section and the react example must be present.
    expect(skill).toContain("https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=68672");
    expect(skill).toContain("/reactions/");
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "active" });
});

test("remove deletes the skill dir; status returns to inactive", async () => {
    const { ctx, root } = tempCtx();
    await drain(cliHandler.apply(ctx, "discord", discord.config));
    await cliHandler.remove!(ctx, "discord", discord.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });
});

test("cliEnvOf maps the stored token to the CLI's env var; ignores non-cli capabilities", () => {
    const mcp: Capability = { id: "x", kind: "mcp", config: { url: "https://a/mcp" } };
    expect(cliEnvOf([discord, mcp])).toEqual({ DISCORD_BOT_TOKEN: "tok-123" });
    expect(cliEnvOf([mcp])).toEqual({});
});

test("cliEnvOf maps secret + non-secret URL for each provider", () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh" } };
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.example.com" } };
    const redmine: Capability = { id: "redmine", kind: "cli", config: { provider: "redmine", url: "https://r.example.com", apiKey: "rk" } };
    const imap: Capability = { id: "imap", kind: "cli", config: { provider: "imap", host: "imap.example.com", port: 993, username: "u@e.com", password: "pw" } };
    expect(cliEnvOf([github])).toEqual({ GITHUB_TOKEN: "gh" });
    expect(cliEnvOf([gitlab])).toEqual({ GITLAB_TOKEN: "gl", GITLAB_URL: "https://gitlab.example.com" });
    expect(cliEnvOf([redmine])).toEqual({ REDMINE_URL: "https://r.example.com", REDMINE_API_KEY: "rk" });
    expect(cliEnvOf([imap])).toEqual({ IMAP_HOST: "imap.example.com", IMAP_PORT: "993", IMAP_USERNAME: "u@e.com", IMAP_PASSWORD: "pw" });
    // Merges across multiple cli capabilities.
    expect(cliEnvOf([github, redmine])).toEqual({ GITHUB_TOKEN: "gh", REDMINE_URL: "https://r.example.com", REDMINE_API_KEY: "rk" });
});

test("every provider has a non-empty skill with front-matter", () => {
    for (const [name, provider] of Object.entries(cliProviders)) {
        expect(provider.skill, name).toContain(`name: ${name}`);
        expect(provider.skill.length).toBeGreaterThan(100);
    }
});

test("echoConfig never leaks the token — only provider + hasToken", () => {
    expect(echoConfig(discord)).toEqual({ provider: "discord", hasToken: true });
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.com" } };
    expect(echoConfig(gitlab)).toEqual({ provider: "gitlab", hasToken: true });
});
