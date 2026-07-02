import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// The last-synced agreed state, one entry per mirrored file, keyed by root-relative path. `hash` is what BOTH
// sides held at the last sync — the engine diffs live hashes against it to tell "the other side changed" from
// "I changed" from "both changed" (a conflict). `size` lets reconnect skip a network pull when a remote file's
// size still matches (the cheap-diff shortcut); content collisions at equal size are caught by the live stream.
export interface ManifestEntry {
    readonly size: number;
    readonly hash: string;
}
export type Manifest = Map<string, ManifestEntry>;

export const loadManifest = async (path: string): Promise<Manifest> => {
    try {
        return new Map(Object.entries(JSON.parse(await readFile(path, "utf8")) as Record<string, ManifestEntry>));
    } catch {
        return new Map();
    }
};

export const saveManifest = async (path: string, manifest: Manifest): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(Object.fromEntries(manifest)), "utf8");
};
