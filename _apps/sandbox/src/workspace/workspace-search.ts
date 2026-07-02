import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { WorkspaceSearch, WorkspaceSearchFile } from "@intentic/sandbox-contract";
import { IGNORED_DIRS, isSecretFile } from "./workspace-tree.js";

// Case-insensitive literal content search over /work — the /workspace/search wire shape. Walks the same files
// walkWorkspaceTree lists (same ignored dirs, secret denylist, symlink skip), so search can never surface a path
// the tree wouldn't. Pure Node, no ripgrep in the sandbox image.
// ponytail: sequential scan of every text file per query; add ripgrep to the image if large workspaces feel slow.

const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_MATCHES = 20;
const MAX_TOTAL_MATCHES = 200;
const MAX_FILES_SCANNED = 5000;
// Long lines (minified bundles) ship as a window around the first match, not the whole line.
const SNIPPET_MAX = 200;
const SNIPPET_LEAD = 40;

export const searchWorkspaceFiles = async (
    root: string,
    query: string,
    options?: { maxDepth?: number; maxFileBytes?: number; maxFileMatches?: number; maxTotalMatches?: number; maxFilesScanned?: number },
): Promise<WorkspaceSearch> => {
    const base = resolve(root);
    const maxDepth = options?.maxDepth ?? MAX_DEPTH;
    const maxFileBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;
    const maxFileMatches = options?.maxFileMatches ?? MAX_FILE_MATCHES;
    const maxTotalMatches = options?.maxTotalMatches ?? MAX_TOTAL_MATCHES;
    const maxFilesScanned = options?.maxFilesScanned ?? MAX_FILES_SCANNED;
    // Lowercase both sides once for case-insensitive matching. Ceiling: exotic lowercasings that change string
    // length (İ) can skew start/end by a char on that line — cosmetic, the snippet is still right.
    const needle = query.toLowerCase();
    const files: WorkspaceSearchFile[] = [];
    let total = 0;
    let scanned = 0;
    let truncated = false;

    const searchFile = async (abs: string, path: string): Promise<void> => {
        const size = await stat(abs)
            .then((s) => s.size)
            .catch(() => undefined);
        if (size === undefined || size === 0 || size > maxFileBytes) {
            return;
        }
        const buf = await readFile(abs).catch(() => undefined);
        if (buf === undefined || buf.includes(0)) {
            return;
        }
        const lines = buf.toString("utf8").split(/\r?\n/);
        const matches: WorkspaceSearchFile["matches"] = [];
        for (let index = 0; index < lines.length; index++) {
            const lineText = lines[index] ?? "";
            const at = lineText.toLowerCase().indexOf(needle);
            if (at === -1) {
                continue;
            }
            if (matches.length >= maxFileMatches || total >= maxTotalMatches) {
                truncated = true;
                break;
            }
            const sliceStart = lineText.length > SNIPPET_MAX ? Math.max(0, at - SNIPPET_LEAD) : 0;
            const text = lineText.slice(sliceStart, sliceStart + SNIPPET_MAX);
            const start = at - sliceStart;
            matches.push({ line: index + 1, text, start, end: Math.min(start + needle.length, text.length) });
            total++;
        }
        if (matches.length > 0) {
            files.push({ path, matches });
        }
    };

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth) {
            truncated = true;
            return;
        }
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
        if (dirents === undefined) {
            return;
        }
        // Same ordering as the tree walk so results appear in the order the sidebar lists them.
        dirents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const dirent of dirents) {
            if (total >= maxTotalMatches) {
                truncated = true;
                return;
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
            if (isDir) {
                await walk(abs, depth + 1);
                continue;
            }
            if (scanned >= maxFilesScanned) {
                truncated = true;
                return;
            }
            scanned++;
            await searchFile(abs, relative(base, abs).split(sep).join("/"));
        }
    };

    await walk(base, 0);
    return { files, truncated };
};
