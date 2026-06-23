import { expect, test } from "vitest";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi } from "./cloudflare-api.js";

// A CloudflareApi whose every method throws unless overridden — the zone provider only calls getZone.
const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the cloudflare provider");
};
const api = (overrides: Partial<CloudflareApi>): CloudflareApi => ({
    getZone: NOT_USED,
    findTunnel: NOT_USED,
    createTunnel: NOT_USED,
    getTunnelToken: NOT_USED,
    getTunnelIngress: NOT_USED,
    putTunnelIngress: NOT_USED,
    findDnsRecord: NOT_USED,
    createDnsRecord: NOT_USED,
    updateDnsRecord: NOT_USED,
    deleteTunnel: NOT_USED,
    deleteDnsRecord: NOT_USED,
    ...overrides,
});

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "cf",
    output: () => {
        throw new Error("unused in cloudflare provider");
    },
});

const inputs = { accountId: "acct-1", apiToken: "token-xyz", zone: "example.com" };

test("read resolves the owned zone to its id", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => ({ id: "zone-abc" }) }));
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { zoneId: "zone-abc" } });
});

test("read returns undefined and logs when the zone is not found", async () => {
    const logs: string[] = [];
    const provider = createCloudflareProvider(api({ getZone: async () => undefined }));
    expect(
        await provider.read(
            inputs,
            ctx((message) => logs.push(message)),
        ),
    ).toBeUndefined();
    expect(logs.some((message) => message.includes("not found"))).toBe(true);
});

test("read propagates an API error", async () => {
    const provider = createCloudflareProvider(
        api({
            getZone: async () => {
                throw new Error("HTTP 403");
            },
        }),
    );
    await expect(provider.read(inputs, ctx())).rejects.toThrow(/403/);
});

test("apply returns the zone id when found", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => ({ id: "zone-abc" }) }));
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({ zoneId: "zone-abc" });
});

test("apply throws when the owned zone does not exist", async () => {
    const provider = createCloudflareProvider(api({ getZone: async () => undefined }));
    await expect(provider.apply(inputs, undefined, ctx())).rejects.toThrow(/does not exist/);
});

test("diff is always noop for an owned zone", () => {
    const provider = createCloudflareProvider(api({}));
    expect(provider.diff(inputs, { outputs: {} })).toEqual({ action: "noop" });
});

test("the account and token flow through to getZone", async () => {
    let captured: { accountId: string; apiToken: string; zone: string } | undefined;
    const provider = createCloudflareProvider(
        api({
            getZone: async (args) => {
                captured = args;
                return { id: "z" };
            },
        }),
    );
    await provider.read(inputs, ctx());
    expect(captured).toEqual({ accountId: "acct-1", apiToken: "token-xyz", zone: "example.com" });
});

test("malformed inputs are rejected", async () => {
    const provider = createCloudflareProvider(api({}));
    await expect(provider.read({ accountId: "a", zone: "z" }, ctx())).rejects.toThrow(/cloudflare inputs malformed/);
});
