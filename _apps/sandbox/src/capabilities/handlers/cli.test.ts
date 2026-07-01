import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../capability.js";
import { cliEnvOf } from "../cli-env.js";
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

test("echoConfig never leaks the token — only provider + hasToken", () => {
    expect(echoConfig(discord)).toEqual({ provider: "discord", hasToken: true });
});
