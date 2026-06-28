import { expect, test } from "vitest";
import { type ChannelSocket, connectChannel, type Dialer } from "./channel.js";
import type { Controller } from "./control.js";

// A fake socket whose inbound messages the test drives and whose outbound sends it records.
const fakeSocket = () => {
    const sent: unknown[] = [];
    let onMessage: ((data: string) => void) | undefined;
    let onOpen: (() => void) | undefined;
    const socket: ChannelSocket = {
        send: (data) => sent.push(JSON.parse(data)),
        close: () => {},
        onOpen: (cb) => {
            onOpen = cb;
        },
        onMessage: (cb) => {
            onMessage = cb;
        },
        onClose: () => {},
    };
    return { socket, sent, deliver: (data: unknown) => onMessage?.(JSON.stringify(data)), open: () => onOpen?.() };
};

const fakeController = (): Controller => ({
    ensure: async () => ({ name: `intentic-sandbox-workspace`, daemonUrl: `http://intentic-sandbox-workspace:8787`, devPort: 5173 }),
    remove: async () => {},
    status: async () => ({ running: true, image: `img` }),
    relay: async function* () {
        yield `data: a`;
    },
});

test("the token rides as a query param on the dialed url", () => {
    let dialed = ``;
    const dial: Dialer = (url) => {
        dialed = url;
        return fakeSocket().socket;
    };
    connectChannel({
        url: `wss://platform.example/runner/gateway`,
        token: `tok 1`,
        controller: fakeController(),
        signal: new AbortController().signal,
        dial,
    });
    expect(dialed).toBe(`wss://platform.example/runner/gateway?token=tok%201`);
});

test("a command is dispatched and its events are streamed back tagged with the requestId", async () => {
    const fake = fakeSocket();
    connectChannel({ url: `wss://p/gw`, token: `t`, controller: fakeController(), signal: new AbortController().signal, dial: () => fake.socket });
    fake.deliver({ requestId: `r1`, command: { kind: `status` } });
    // Let the async dispatch settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent).toEqual([
        { requestId: `r1`, event: { kind: `status`, running: true, image: `img` } },
        { requestId: `r1`, event: { kind: `done` } },
    ]);
});

test("a malformed frame or one missing requestId is ignored", async () => {
    const fake = fakeSocket();
    connectChannel({ url: `wss://p/gw`, token: `t`, controller: fakeController(), signal: new AbortController().signal, dial: () => fake.socket });
    fake.deliver({ command: { kind: `status` } }); // no requestId
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sent).toEqual([]);
});
