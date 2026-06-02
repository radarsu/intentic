export type ReadinessProbe = (url: string, expectedStatus: number) => Promise<boolean>;

// Only "<seconds>s" durations exist in the graph this increment (120s/90s/60s).
export const parseDuration = (text: string): number => {
    const match = /^(\d+)s$/.exec(text);
    if (match === null) {
        throw new Error(`unsupported duration "${text}" (expected "<seconds>s")`);
    }
    return Number(match[1]) * 1000;
};

export const httpProbe: ReadinessProbe = async (url, expectedStatus) => {
    const response = await fetch(url, { method: "GET" });
    return response.status === expectedStatus || response.status < 400;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Poll `probe` until it succeeds or the timeout elapses; throws on timeout. The probe is injected so
// tests never hit the network.
export const waitReady = async (
    url: string,
    options: { readonly status?: number; readonly timeout?: string },
    probe: ReadinessProbe,
    intervalMs = 1000,
): Promise<void> => {
    const expected = options.status ?? 200;
    const limit = options.timeout !== undefined ? parseDuration(options.timeout) : 60000;
    const deadline = Date.now() + limit;
    for (;;) {
        if (await probe(url, expected)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`readiness check timed out after ${limit}ms for ${url}`);
        }
        await sleep(intervalMs);
    }
};
