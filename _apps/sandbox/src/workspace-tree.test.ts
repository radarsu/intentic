import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isDeniedWorkspacePath, isSecretFile, type WorkspaceTreeEntry, walkWorkspaceTree } from "./workspace-tree.js";

test("isSecretFile flags credential files but allows .env.example", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile(".env.local")).toBe(true);
    expect(isSecretFile(".env.production")).toBe(true);
    expect(isSecretFile(".secrets.json")).toBe(true);
    expect(isSecretFile("claude.json")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("deploy.config.ts")).toBe(false);
});

test("isDeniedWorkspacePath denies secrets and anything under .git", () => {
    expect(isDeniedWorkspacePath("desired-state/.env")).toBe(true);
    expect(isDeniedWorkspacePath(".intentic/claude.json")).toBe(true);
    expect(isDeniedWorkspacePath("app/.git/config")).toBe(true);
    expect(isDeniedWorkspacePath("app/src/index.ts")).toBe(false);
    expect(isDeniedWorkspacePath("intent/.env.example")).toBe(false);
});

// Flatten the nested tree to a set of paths for easy assertions.
const paths = (entries: readonly WorkspaceTreeEntry[]): string[] =>
    entries.flatMap((entry) => [entry.path, ...(entry.children ? paths(entry.children) : [])]);

test("walkWorkspaceTree surfaces untracked files, skips ignored dirs + secrets, and keeps .env.example", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-"));
    await mkdir(join(root, "app", "src"), { recursive: true });
    await mkdir(join(root, "app", "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, "app", ".git"), { recursive: true });
    await mkdir(join(root, ".intentic"), { recursive: true });
    await mkdir(join(root, "desired-state"), { recursive: true });
    await writeFile(join(root, "app", "src", "index.ts"), "console.log(1);");
    await writeFile(join(root, "app", "untracked.tmp"), "scratch"); // untracked — should still show
    await writeFile(join(root, "app", "node_modules", "dep", "index.js"), "module.exports={}");
    await writeFile(join(root, "app", ".git", "config"), "[core]");
    await writeFile(join(root, ".intentic", "claude.json"), '{"accessToken":"secret"}');
    await writeFile(join(root, "desired-state", ".env"), "SECRET=1");
    await writeFile(join(root, "desired-state", ".env.example"), "SECRET=");

    const result = await walkWorkspaceTree(root);
    const all = paths(result.tree);

    expect(result.truncated).toBe(false);
    expect(all).toContain("app/src/index.ts");
    expect(all).toContain("app/untracked.tmp");
    expect(all).toContain("desired-state/.env.example");
    // ignored dirs and secrets are excluded entirely
    expect(all).not.toContain("app/node_modules");
    expect(all).not.toContain("app/.git");
    expect(all).not.toContain(".intentic/claude.json");
    expect(all).not.toContain("desired-state/.env");
});

test("walkWorkspaceTree flags truncated when the entry cap is hit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-tree-cap-"));
    for (let i = 0; i < 5; i++) {
        await writeFile(join(root, `file-${i}.txt`), "x");
    }
    const result = await walkWorkspaceTree(root, { maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(paths(result.tree).length).toBe(2);
});
