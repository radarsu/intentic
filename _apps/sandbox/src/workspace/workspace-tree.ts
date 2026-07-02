import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract";

// WorkspaceTree / WorkspaceTreeEntry (the full /work tree the agent sees — untracked files, generated
// artifacts, and .intentic/ included, distinct from the git-tracked listing) are the /workspace/tree wire
// shape, so they live in @intentic/sandbox-contract. `path` is root-relative with forward slashes so it feeds
// straight back to the file route.

// Directories never worth surfacing — huge or machine-generated; the agent ignores them too. `.git` is also
// excluded because it can hold remote URLs with embedded tokens.
export const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".cache", ".turbo", ".next", ".angular"]);

const MAX_DEPTH = 12;
const MAX_ENTRIES = 5000;

// Files that hold secrets: the full-tree view must never list or read them (the tracked-git view never could,
// since they aren't committed). `.env.example` is safe — placeholder values only.
export const isSecretFile = (name: string): boolean =>
    name === ".secrets.json" || name === "claude.json" || name === "capabilities.json" || (name.startsWith(".env") && name !== ".env.example");

// Guards the file route: reject reading anything under .git or any secret file, even when the path is asked for
// directly (it is never listed, but the route must not serve it either).
export const isDeniedWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    const name = segments.at(-1) ?? "";
    return segments.includes(".git") || isSecretFile(name);
};

// The full prune set for the live watcher: everything the tree walk skips — the machine-generated dirs plus the
// denied (.git/secret) paths. Kept here so the watcher and the walk share ONE ignore definition.
export const isIgnoredWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some((segment) => IGNORED_DIRS.has(segment)) || isDeniedWorkspacePath(relPath);
};

// Walk the real working tree under `root`, bounded by depth/entry caps so a pathological tree can't blow up the
// response. Directories sort before files, alphabetically within each. Symlinks are skipped (not followed, not
// listed) so the walk can't escape the workspace.
export const walkWorkspaceTree = async (root: string, options?: { maxDepth?: number; maxEntries?: number }): Promise<WorkspaceTree> => {
    const base = resolve(root);
    const maxDepth = options?.maxDepth ?? MAX_DEPTH;
    const maxEntries = options?.maxEntries ?? MAX_ENTRIES;
    let count = 0;
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<WorkspaceTreeEntry[]> => {
        if (depth > maxDepth) {
            truncated = true;
            return [];
        }
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
        if (dirents === undefined) {
            return [];
        }
        dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

        const entries: WorkspaceTreeEntry[] = [];
        for (const dirent of dirents) {
            if (count >= maxEntries) {
                truncated = true;
                break;
            }
            if (dirent.isSymbolicLink()) {
                continue;
            }
            const isDir = dirent.isDirectory();
            if (isDir && IGNORED_DIRS.has(dirent.name)) {
                continue;
            }
            if (!isDir && isSecretFile(dirent.name)) {
                continue;
            }
            const abs = join(dir, dirent.name);
            const path = relative(base, abs).split(sep).join("/");
            count++;
            if (isDir) {
                entries.push({ name: dirent.name, path, type: "dir", children: await walk(abs, depth + 1) });
                continue;
            }
            let meta: { size: number; mtime: number } | undefined;
            try {
                const info = await stat(abs);
                meta = { size: info.size, mtime: info.mtimeMs };
            } catch {
                meta = undefined;
            }
            entries.push({ name: dirent.name, path, type: "file", ...(meta ?? {}) });
        }
        return entries;
    };

    const tree = await walk(base, 0);
    return { root: base, tree, truncated };
};
