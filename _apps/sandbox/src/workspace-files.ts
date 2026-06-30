import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";

// Resolve a repo-relative path to an absolute one, guarding against escaping the repo dir: the daemon serves
// file reads/writes for the workspace repos, so a `../` or absolute path must not reach outside them. Returns
// undefined for the dir itself or any path that climbs out (the daemon answers 400 rather than touching it).
export const resolveWithin = (dir: string, relPath: string): string | undefined => {
    const base = resolve(dir);
    const target = resolve(base, relPath);
    const rel = relative(base, target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
        return undefined;
    }
    return target;
};

// Read a workspace file's text; undefined when it does not exist (the daemon maps that to 404). The path is
// already repo-contained by resolveWithin at the call site.
export const readWorkspaceFile = async (absPath: string): Promise<string | undefined> => {
    try {
        return await readFile(absPath, "utf8");
    } catch {
        return undefined;
    }
};

export const writeWorkspaceFile = async (absPath: string, content: string): Promise<void> => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content);
};

// The browser previews binary files (images, PDFs) by fetching their raw bytes from /workspace/raw — the text
// read above utf8-decodes and would corrupt them. Read the bytes verbatim; undefined when absent (→ 404).
export const readWorkspaceFileBytes = async (absPath: string): Promise<Buffer | undefined> => {
    try {
        return await readFile(absPath);
    } catch {
        return undefined;
    }
};

// The file's size, used to refuse an oversized raw read BEFORE loading it into memory; undefined when absent.
export const statWorkspaceFileSize = async (absPath: string): Promise<number | undefined> => {
    try {
        return (await stat(absPath)).size;
    } catch {
        return undefined;
    }
};

// Hard cap on a single raw read — the browser holds the whole response as a Blob, so keep it bounded (→ 413).
export const MAX_RAW_BYTES = 25 * 1024 * 1024;

// Best-effort Content-Type for the raw route, by extension — enough for the formats the viewer previews (images
// + PDF); everything else is generic binary (the browser offers a download). No mime dependency on purpose.
const MIME_BY_EXT: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    pdf: "application/pdf",
};
export const contentTypeForPath = (absPath: string): string => MIME_BY_EXT[extname(absPath).slice(1).toLowerCase()] ?? "application/octet-stream";
