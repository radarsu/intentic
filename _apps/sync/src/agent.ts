import { relative, sep } from "node:path";
import { watch } from "chokidar";
import { idTokenFromRefresh } from "./auth.js";
import { createSandboxClient } from "./client.js";
import { manifestPath, readConfig, readCredentials } from "./config.js";
import { createSyncEngine } from "./engine.js";
import { isIgnored } from "./fs-util.js";
import { loadManifest, saveManifest } from "./manifest.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const decodeExpSeconds = (jwt: string): number => {
    const payload = jwt.split(".")[1];
    if (payload === undefined) {
        return 0;
    }
    try {
        return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number }).exp ?? 0;
    } catch {
        return 0;
    }
};

// Cache the ID token until a minute before it expires, then mint a fresh one from the refresh token. A long
// watch connection is authed once at open, but per-file raw/upload calls each need a live token.
const createTokenProvider = (clientId: string, clientSecret: string, refreshToken: string): (() => Promise<string>) => {
    let cached: { token: string; exp: number } | undefined;
    return async () => {
        if (cached !== undefined && cached.exp - 60 > Date.now() / 1000) {
            return cached.token;
        }
        const token = await idTokenFromRefresh(clientId, clientSecret, refreshToken);
        cached = { token, exp: decodeExpSeconds(token) };
        return token;
    };
};

// The background agent: reconcile, then stream remote changes while a local watcher streams the other way, all
// funneled through one serial queue so a remote and a local edit to the same file can't interleave mid-apply.
// A dropped stream just loops back to reconcile, closing the gap. Runs until the process is stopped.
export const run = async (): Promise<void> => {
    const config = await readConfig();
    const credentials = await readCredentials();
    if (credentials === undefined) {
        throw new Error("intentic-sync is not set up — run `intentic-sync setup` first.");
    }

    const getToken = createTokenProvider(config.googleClientId, config.googleClientSecret, credentials.refreshToken);
    const client = createSandboxClient(config.sandboxUrl, getToken);
    const manifestFile = manifestPath(config.sandboxId);
    const manifest = await loadManifest(manifestFile);

    const log = (message: string): void => void process.stdout.write(`${new Date().toISOString()} ${message}\n`);
    let dirty = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = (): void => {
        dirty = true;
        if (saveTimer !== undefined) {
            return;
        }
        saveTimer = setTimeout(() => {
            saveTimer = undefined;
            if (dirty) {
                dirty = false;
                void saveManifest(manifestFile, manifest);
            }
        }, 500);
    };

    const engine = createSyncEngine({ localDir: config.localDir, client, manifest, persist, log, now: () => Date.now() });

    // Serialize every mutation (reconcile + both event handlers) — a global lock, the simplest correct model
    // for one mirror. ponytail: per-path locks if a huge tree makes the single queue a throughput bottleneck.
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = chain.then(operation, operation);
        chain = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    };

    const watcher = watch(config.localDir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        ignored: (candidate) => {
            const rel = relative(config.localDir, candidate).split(sep).join("/");
            return rel !== "" && isIgnored(rel);
        },
    });
    const onLocal = (candidate: string): void => {
        const rel = relative(config.localDir, candidate).split(sep).join("/");
        if (rel === "") {
            return;
        }
        void serialize(() => engine.onLocalPath(rel)).catch((error) => log(`local sync error on ${rel}: ${error instanceof Error ? error.message : String(error)}`));
    };
    watcher.on("add", onLocal).on("change", onLocal).on("unlink", onLocal);

    log(`mirroring ${config.sandboxUrl} → ${config.localDir}`);
    for (;;) {
        const controller = new AbortController();
        try {
            await serialize(() => engine.reconcile());
            log("reconciled; watching for changes");
            for await (const change of client.watch(controller.signal)) {
                await serialize(() => engine.onRemoteChange(change)).catch((error) =>
                    log(`remote sync error on ${change.path}: ${error instanceof Error ? error.message : String(error)}`),
                );
            }
        } catch (error) {
            log(`stream dropped: ${error instanceof Error ? error.message : String(error)}; retrying in 5s`);
        } finally {
            controller.abort();
        }
        await delay(5000);
    }
};
