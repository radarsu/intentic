// Tell the platform this sandbox's own public URL so the browser can be directed straight to its daemon (the
// decentralized path). The platform is only a directory, never on the command path, so this is best-effort: a
// failure here must not stop the daemon from serving.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Derive the platform's HTTP origin from PLATFORM_URL — the base the sandbox registers against. Normalizes a
// ws/wss scheme to http/https and strips any path (e.g. https://host/x → https://host). undefined when unparseable.
export const platformBaseFrom = (platformUrl: string): string | undefined => {
    try {
        const url = new URL(platformUrl);
        const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
        return `${protocol}//${url.host}`;
    } catch {
        return undefined;
    }
};

// Local-dev platform hosts are never publicly routable, so an https platform running there carries a
// self-signed cert — Node's TLS verification would reject it (the daemon would log "could not reach the
// platform"). Skip verification for these hosts only; a public platform (app.intentic.dev) still verifies.
const isLocalDevHost = (hostname: string): boolean =>
    hostname === "host.docker.internal" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

// POST the registration over node:http(s) (not fetch) so the https path can relax cert verification for a
// local-dev host without a global NODE_TLS_REJECT_UNAUTHORIZED that would also weaken the daemon's Google-token
// verification. Resolves the response status; rejects on a connection-level failure.
const postRegister = (url: URL, body: string, connectToken: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const https = url.protocol === "https:";
        const requestFn = https ? httpsRequest : httpRequest;
        const request = requestFn(
            url,
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                    authorization: `Bearer ${connectToken}`,
                },
                ...(https && isLocalDevHost(url.hostname) ? { rejectUnauthorized: false } : {}),
            },
            (response) => {
                response.resume();
                resolve(response.statusCode ?? 0);
            },
        );
        request.on("error", reject);
        request.end(body);
    });

export const registerWithPlatform = async (args: {
    readonly platformUrl: string;
    readonly connectToken: string;
    readonly daemonUrl: string;
    readonly log: (message: string) => void;
}): Promise<void> => {
    const base = platformBaseFrom(args.platformUrl);
    if (base === undefined) {
        args.log(`register: could not derive a platform URL from "${args.platformUrl}"; skipping`);
        return;
    }
    try {
        const status = await postRegister(new URL(`${base}/sandbox/register`), JSON.stringify({ daemonUrl: args.daemonUrl }), args.connectToken);
        if (status < 200 || status >= 300) {
            args.log(`register: platform returned ${status} for ${args.daemonUrl}`);
            return;
        }
        args.log(`register: ${args.daemonUrl} registered with the platform`);
    } catch (error) {
        args.log(`register: could not reach the platform (${String(error)})`);
    }
};
