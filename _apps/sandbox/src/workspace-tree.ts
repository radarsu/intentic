import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// One node of the full /work filesystem tree the agent sees. Distinct from the git-tracked tree: untracked
// files, generated artifacts, and .intentic/ all show here. `path` is root-relative with forward slashes so
// the platform can feed it straight back to the file route.
export interface WorkspaceTreeEntry {
    readonly name: string;
    readonly path: string;
    readonly type: "file" | "dir";
    readonly size?: number;
    readonly children?: readonly WorkspaceTreeEntry[];
}

export interface WorkspaceTree {
    readonly root: string;
    readonly tree: readonly WorkspaceTreeEntry[];
    // True when the walk hit the depth/entry cap and the returned tree is partial.
    readonly truncated: boolean;
}

// Directories never worth surfacing — huge or machine-generated; the agent ignores them too. `.git` is also
// excluded because it can hold remote URLs with embedded tokens.
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".cache", ".turbo", ".next", ".angular"]);

const MAX_DEPTH = 12;
const MAX_ENTRIES = 5000;

// Files that hold secrets: the full-tree view must never list or read them (the tracked-git view never could,
// since they aren't committed). `.env.example` is safe — placeholder values only.
export const isSecretFile = (name: string): boolean =>
    name === ".secrets.json" || name === "claude.json" || name === "tools.json" || (name.startsWith(".env") && name !== ".env.example");

// Guards the file route: reject reading anything under .git or any secret file, even when the path is asked for
// directly (it is never listed, but the route must not serve it either).
export const isDeniedWorkspacePath = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    const name = segments.at(-1) ?? "";
    return segments.includes(".git") || isSecretFile(name);
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
            let size: number | undefined;
            try {
                size = (await stat(abs)).size;
            } catch {
                size = undefined;
            }
            entries.push({ name: dirent.name, path, type: "file", ...(size !== undefined ? { size } : {}) });
        }
        return entries;
    };

    const tree = await walk(base, 0);
    return { root: base, tree, truncated };
};
