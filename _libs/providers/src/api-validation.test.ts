import { afterEach, expect, test, vi } from "vitest";
import { cloudflareApi } from "./cloudflare-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { komodoApi } from "./komodo-api.js";

// Stub global fetch with a single canned response so the default adapters' response validation can be
// exercised without the network. The adapters only use response.ok/status/json()/text().
const stubFetch = (body: unknown, status = 200): void => {
    vi.stubGlobal("fetch", async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    }));
};

afterEach(() => {
    vi.unstubAllGlobals();
});

const creds = { baseUrl: "https://git.example.com", user: "admin", password: "pw", owner: "admin", name: "my-app" };

test("forgejo findRepo parses a well-formed repo response", async () => {
    stubFetch({ clone_url: "https://git.example.com/admin/my-app.git", ssh_url: "git@git.example.com:admin/my-app.git", extra: "ignored" });
    expect(await forgejoApi.findRepo(creds)).toEqual({
        cloneUrl: "https://git.example.com/admin/my-app.git",
        sshUrl: "git@git.example.com:admin/my-app.git",
    });
});

test("forgejo findRepo throws a boundary error when the response is the wrong shape", async () => {
    stubFetch({ clone_url: 123 });
    await expect(forgejoApi.findRepo(creds)).rejects.toThrow(/returned an unexpected response/);
});

test("cloudflare getZone parses a well-formed envelope", async () => {
    stubFetch({ success: true, errors: [], result: [{ id: "zone-1" }] });
    expect(await cloudflareApi.getZone({ accountId: "a", apiToken: "t", zone: "example.com" })).toEqual({ id: "zone-1" });
});

test("cloudflare getZone throws a boundary error when the result item lacks an id", async () => {
    stubFetch({ success: true, errors: [], result: [{}] });
    await expect(cloudflareApi.getZone({ accountId: "a", apiToken: "t", zone: "example.com" })).rejects.toThrow(/returned an unexpected response/);
});

test("cloudflare surfaces an API error envelope (success:false) as a failed call", async () => {
    stubFetch({ success: false, errors: [{ code: 1003, message: "invalid zone" }], result: null });
    await expect(cloudflareApi.getZone({ accountId: "a", apiToken: "t", zone: "example.com" })).rejects.toThrow(/failed.*invalid zone/);
});

test("komodo getAlerter parses a well-formed alerter config", async () => {
    const config = {
        enabled: true,
        endpoint: { type: "Discord", params: { url: "https://discord.test/wh" } },
        alert_types: ["DeploymentStateChange"],
        resources: [],
        except_resources: [],
    };
    stubFetch({ config });
    expect(await komodoApi.getAlerter({ baseUrl: "https://komodo.example.com", jwt: "j", id: "a1" })).toEqual(config);
});

test("komodo getAlerter throws a boundary error when the alerter config is malformed", async () => {
    stubFetch({ config: { enabled: "yes" } });
    await expect(komodoApi.getAlerter({ baseUrl: "https://komodo.example.com", jwt: "j", id: "a1" })).rejects.toThrow(
        /returned an unexpected response/,
    );
});
