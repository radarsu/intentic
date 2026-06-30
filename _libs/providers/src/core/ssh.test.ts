import { expect, test } from "vitest";
import { inMemoryHostKeyStore, verifyHostKey } from "./ssh.js";

test("an unseen host is trusted on first use and its key is pinned", async () => {
    const store = inMemoryHostKeyStore();
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_A")).toBe("ok");
    expect(await store.get("203.0.113.10", 22)).toBe("KEY_A");
});

test("a pinned host presenting the same key is accepted", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_A")).toBe("ok");
});

test("a pinned host presenting a different key is a mismatch and the pin is unchanged", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 22, "KEY_B")).toBe("mismatch");
    expect(await store.get("203.0.113.10", 22)).toBe("KEY_A");
});

test("the same address on a different port is a distinct host", async () => {
    const store = inMemoryHostKeyStore();
    await verifyHostKey(store, "203.0.113.10", 22, "KEY_A");
    expect(await verifyHostKey(store, "203.0.113.10", 2222, "KEY_B")).toBe("ok");
});
