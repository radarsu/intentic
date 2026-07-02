import type { Stats } from "node:fs";
import { relative, sep } from "node:path";
import type { WorkspaceChange } from "@intentic/sandbox-contract";
import { watch as chokidarWatch } from "chokidar";
import type { Logger } from "pino";
import { isIgnoredWorkspacePath } from "./workspace-tree.js";

// Map a chokidar event to a wire change. size+mtime ride along on add/change (chokidar hands us the Stats when
// alwaysStat is on); the delete/dir events carry only the path. Non-fs events (ready/raw) map to undefined.
const toChange = (event: string, path: string, stats: Stats | undefined): WorkspaceChange | undefined => {
    if (event === "add" || event === "change") {
        return stats === undefined ? { kind: event, path } : { kind: event, path, size: stats.size, mtime: stats.mtimeMs };
    }
    if (event === "unlink" || event === "addDir" || event === "unlinkDir") {
        return { kind: event, path };
    }
    return undefined;
};

// One process-wide chokidar watcher over /work, fanned out to every /workspace/watch subscriber (an SSE
// connection). Started lazily on the first subscribe and kept for the process lifetime — reconnecting clients
// reuse it rather than paying a fresh recursive scan each time. The same ignore set as the tree walk prunes
// node_modules/.git/secrets, so a big dependency dir never floods the stream (or gets mirrored).
export const createWorkspaceWatch = (root: string, logger: Logger): (() => AsyncGenerator<WorkspaceChange>) => {
    const subscribers = new Set<(change: WorkspaceChange) => void>();
    let started = false;

    const start = (): void => {
        if (started) {
            return;
        }
        started = true;
        const watcher = chokidarWatch(root, {
            ignoreInitial: true,
            alwaysStat: true,
            // Debounce partial writes so a large save emits one settled `change`, not a burst mid-write.
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
            ignored: (candidate) => {
                const rel = relative(root, candidate).split(sep).join("/");
                return rel !== "" && isIgnoredWorkspacePath(rel);
            },
        });
        watcher.on("all", (event, path, stats) => {
            const rel = relative(root, path).split(sep).join("/");
            if (rel === "" || isIgnoredWorkspacePath(rel)) {
                return;
            }
            const change = toChange(event, rel, stats);
            if (change === undefined) {
                return;
            }
            for (const push of subscribers) {
                push(change);
            }
        });
        watcher.on("error", (error) => logger.error({ error }, "workspace watcher error"));
    };

    return async function* watch(): AsyncGenerator<WorkspaceChange> {
        start();
        const buffer: WorkspaceChange[] = [];
        let notify: (() => void) | undefined;
        const push = (change: WorkspaceChange): void => {
            buffer.push(change);
            notify?.();
            notify = undefined;
        };
        subscribers.add(push);
        try {
            while (true) {
                const next = buffer.shift();
                if (next === undefined) {
                    await new Promise<void>((resolve) => {
                        notify = resolve;
                    });
                    continue;
                }
                yield next;
            }
        } finally {
            // The SSE client went away (oRPC aborts the generator) — stop fanning events at it.
            subscribers.delete(push);
        }
    };
};
