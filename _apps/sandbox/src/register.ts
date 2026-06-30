// Tell the platform this sandbox's own public URL so the browser can be directed straight to its daemon (the
// decentralized path). The platform is only a directory, never on the command path, so this is best-effort: a
// failure here must not stop the daemon from serving.

// Derive the platform's HTTP origin from the runner's WSS gateway URL (e.g. wss://host/runner/gateway →
// https://host). undefined when the URL can't be parsed.
export const platformBaseFrom = (platformUrl: string): string | undefined => {
    try {
        const url = new URL(platformUrl);
        const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
        return `${protocol}//${url.host}`;
    } catch {
        return undefined;
    }
};

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
        const response = await fetch(`${base}/sandbox/register`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${args.connectToken}` },
            body: JSON.stringify({ daemonUrl: args.daemonUrl }),
        });
        if (!response.ok) {
            args.log(`register: platform returned ${response.status} for ${args.daemonUrl}`);
            return;
        }
        args.log(`register: ${args.daemonUrl} registered with the platform`);
    } catch (error) {
        args.log(`register: could not reach the platform (${String(error)})`);
    }
};
