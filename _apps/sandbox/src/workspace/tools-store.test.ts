import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fileToolsStore } from "./tools-store.js";

let dir: string;
let store: ReturnType<typeof fileToolsStore>;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-tools-"));
    store = fileToolsStore(join(dir, ".intentic", "tools.json"));
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("an unwritten store lists nothing", async () => {
    expect(await store.list()).toEqual([]);
});

test("add persists a tool (creating .intentic), and list reads it back", async () => {
    await store.add({ name: "linear", url: "https://mcp.linear.app/sse", token: "lin_tok" });
    expect(await store.list()).toEqual([{ name: "linear", url: "https://mcp.linear.app/sse", token: "lin_tok" }]);
    // The file lives under .intentic (on the secret denylist), not in a repo.
    expect(JSON.parse(await readFile(join(dir, ".intentic", "tools.json"), "utf8"))).toHaveLength(1);
});

test("add upserts by name (re-adding edits url/token instead of duplicating)", async () => {
    await store.add({ name: "linear", url: "https://old/sse", token: "a" });
    await store.add({ name: "github", url: "https://gh/mcp" });
    await store.add({ name: "linear", url: "https://new/sse", token: "b" });
    expect(await store.list()).toEqual([
        { name: "github", url: "https://gh/mcp" },
        { name: "linear", url: "https://new/sse", token: "b" },
    ]);
});

test("remove deletes by name and reports whether it existed", async () => {
    await store.add({ name: "linear", url: "https://mcp.linear.app/sse" });
    expect(await store.remove("linear")).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.remove("linear")).toBe(false);
});

test("a corrupt store file reads as empty rather than throwing", async () => {
    const path = join(dir, ".intentic", "tools.json");
    await store.add({ name: "x", url: "https://x/mcp" });
    await rm(path);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, ".intentic"), { recursive: true });
    await writeFile(path, "not json{");
    expect(await store.list()).toEqual([]);
});
