import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { searchWorkspaceFiles } from "./workspace-search.js";

test("searchWorkspaceFiles finds case-insensitive matches with exact highlight offsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-search-"));
    await mkdir(join(root, "app", "src"), { recursive: true });
    await writeFile(join(root, "app", "src", "index.ts"), `const a = 1;\nconsole.log("Hello World");\n`);

    const result = await searchWorkspaceFiles(root, "hello w");

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("app/src/index.ts");
    expect(file.matches).toHaveLength(1);
    const match = file.matches[0]!;
    expect(match.line).toBe(2);
    expect(match.text.slice(match.start, match.end)).toBe("Hello W");
});

test("searchWorkspaceFiles skips ignored dirs, secrets, binaries, and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-search-skip-"));
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "needle");
    await writeFile(join(root, ".git", "config"), "needle");
    await writeFile(join(root, ".env"), "needle");
    await writeFile(join(root, "blob.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]));
    await writeFile(join(root, "big.txt"), "needle padding");
    await writeFile(join(root, "ok.txt"), "a needle here");

    const result = await searchWorkspaceFiles(root, "needle", { maxFileBytes: 13 });

    expect(result.files.map((file) => file.path)).toEqual(["ok.txt"]);
});

test("searchWorkspaceFiles caps matches per file and flags truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-search-file-cap-"));
    await writeFile(join(root, "many.txt"), Array.from({ length: 25 }, () => "needle").join("\n"));

    const result = await searchWorkspaceFiles(root, "needle", { maxFileMatches: 20 });

    expect(result.truncated).toBe(true);
    expect(result.files[0]!.matches).toHaveLength(20);
});

test("searchWorkspaceFiles stops the walk at the total cap and flags truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-search-total-cap-"));
    for (let i = 0; i < 5; i++) {
        await writeFile(join(root, `file-${i}.txt`), "needle\nneedle");
    }

    const result = await searchWorkspaceFiles(root, "needle", { maxTotalMatches: 3 });

    expect(result.truncated).toBe(true);
    const total = result.files.reduce((sum, file) => sum + file.matches.length, 0);
    expect(total).toBe(3);
});

test("searchWorkspaceFiles windows long lines around the match", async () => {
    const root = await mkdtemp(join(tmpdir(), "ws-search-window-"));
    await writeFile(join(root, "minified.js"), `${"x".repeat(500)}needle${"y".repeat(500)}`);

    const result = await searchWorkspaceFiles(root, "needle");

    const match = result.files[0]!.matches[0]!;
    expect(match.text.length).toBeLessThanOrEqual(200);
    expect(match.text.slice(match.start, match.end)).toBe("needle");
});
