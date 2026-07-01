import type { ProviderContext } from "@intentic/engine";
import { expect, test, vi } from "vitest";
import type { ImapChecker } from "./imap-check.js";
import { createImapProvider } from "./imap.js";
import type { OutlineApi } from "./outline-api.js";
import { createOutlineProvider } from "./outline.js";
import type { RedmineApi } from "./redmine-api.js";
import { createRedmineProvider } from "./redmine.js";

const ctx: ProviderContext = { id: "it", log: vi.fn(), env: {}, output: () => undefined };

const acceptLogin: ImapChecker = async () => true;
const rejectLogin: ImapChecker = async () => false;

const redmineInputs = { url: "https://redmine.example.com", apiKey: "key" };
const outlineInputs = { url: "https://outline.example.com", apiKey: "tok" };
const imapInputs = { host: "imap.example.com", port: 993, username: "u@example.com", password: "pw" };

// --- Redmine: validate-only against getCurrentUser ---

test("redmine read returns undefined when the key is rejected", async () => {
    const api: RedmineApi = { getCurrentUser: async () => undefined };
    expect(await createRedmineProvider(api).read(redmineInputs, ctx)).toBeUndefined();
});

test("redmine read returns outputs when the key resolves a user", async () => {
    const api: RedmineApi = { getCurrentUser: async () => ({ id: 1 }) };
    expect(await createRedmineProvider(api).read(redmineInputs, ctx)).toEqual({ outputs: {} });
});

test("redmine read swallows an unreachable instance as not-yet-validated", async () => {
    const api: RedmineApi = {
        getCurrentUser: async () => {
            throw new Error("ECONNREFUSED");
        },
    };
    expect(await createRedmineProvider(api).read(redmineInputs, ctx)).toBeUndefined();
});

test("redmine apply throws on a rejected key", async () => {
    const api: RedmineApi = { getCurrentUser: async () => undefined };
    await expect(createRedmineProvider(api).apply!(redmineInputs, undefined, ctx)).rejects.toThrow("rejected");
});

// --- Outline: validate-only against getAuthInfo ---

test("outline read returns undefined when the token is rejected", async () => {
    const api: OutlineApi = { getAuthInfo: async () => undefined };
    expect(await createOutlineProvider(api).read(outlineInputs, ctx)).toBeUndefined();
});

test("outline apply throws on a rejected token", async () => {
    const api: OutlineApi = { getAuthInfo: async () => undefined };
    await expect(createOutlineProvider(api).apply!(outlineInputs, undefined, ctx)).rejects.toThrow("rejected");
});

test("outline apply succeeds when the token resolves a user", async () => {
    const api: OutlineApi = { getAuthInfo: async () => ({ id: "user-1" }) };
    expect(await createOutlineProvider(api).apply!(outlineInputs, undefined, ctx)).toEqual({});
});

// --- IMAP: validate-only against the login checker ---

test("imap read returns undefined on a rejected login", async () => {
    expect(await createImapProvider(rejectLogin).read(imapInputs, ctx)).toBeUndefined();
});

test("imap read returns outputs on a successful login", async () => {
    expect(await createImapProvider(acceptLogin).read(imapInputs, ctx)).toEqual({ outputs: {} });
});

test("imap read defaults the port to 993 when absent", async () => {
    const check = vi.fn<ImapChecker>(async () => true);
    await createImapProvider(check).read({ host: "imap.example.com", username: "u", password: "pw" }, ctx);
    expect(check.mock.calls[0]![0].port).toBe(993);
});

test("imap apply throws on a rejected login", async () => {
    await expect(createImapProvider(rejectLogin).apply!(imapInputs, undefined, ctx)).rejects.toThrow("rejected");
});

test("imap diff is always noop", () => {
    expect(createImapProvider(acceptLogin).diff(imapInputs, undefined)).toEqual({ action: "noop" });
});
