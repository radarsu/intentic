import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// Mirrors the daemon's tree/watch ignore set (workspace-tree.ts) so both ends prune the same machine-generated
// dirs and never touch secret files. Kept in lockstep by hand — a divergence just means the agent tries to
// mirror something the daemon won't serve (a harmless 404), never a leak.
export const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".cache", ".turbo", ".next", ".angular"]);

const isSecretFile = (name: string): boolean =>
    name === ".secrets.json" || name === "claude.json" || name === "capabilities.json" || (name.startsWith(".env") && name !== ".env.example");

export const isIgnored = (relPath: string): boolean => {
    const segments = relPath.split(/[\\/]/).filter((segment) => segment.length > 0);
    if (segments.some((segment) => IGNORED_DIRS.has(segment))) {
        return true;
    }
    return isSecretFile(segments.at(-1) ?? "");
};

export const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const readLocalBytes = async (absPath: string): Promise<Uint8Array | undefined> => {
    try {
        return await readFile(absPath);
    } catch {
        return undefined;
    }
};

export const hashLocalFile = async (absPath: string): Promise<string | undefined> => {
    const bytes = await readLocalBytes(absPath);
    return bytes === undefined ? undefined : hashBytes(bytes);
};

export interface LocalMeta {
    readonly size: number;
    readonly mtime: number;
}

export const statLocal = async (absPath: string): Promise<LocalMeta | undefined> => {
    try {
        const info = await stat(absPath);
        return { size: info.size, mtime: info.mtimeMs };
    } catch {
        return undefined;
    }
};

// Walk the mirror dir into a map of root-relative file path → size/mtime, pruning ignored dirs and symlinks
// (never followed — matches the daemon's walk). Backs the startup/reconnect reconcile.
export const walkLocalFiles = async (root: string): Promise<Map<string, LocalMeta>> => {
    const files = new Map<string, LocalMeta>();
    const walk = async (dir: string): Promise<void> => {
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const dirent of dirents) {
            const abs = join(dir, dirent.name);
            const rel = relative(root, abs).split(sep).join("/");
            if (isIgnored(rel) || dirent.isSymbolicLink()) {
                continue;
            }
            if (dirent.isDirectory()) {
                await walk(abs);
                continue;
            }
            if (!dirent.isFile()) {
                continue;
            }
            const meta = await statLocal(abs);
            if (meta !== undefined) {
                files.set(rel, meta);
            }
        }
    };
    await walk(root);
    return files;
};
