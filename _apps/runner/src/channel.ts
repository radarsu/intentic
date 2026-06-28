import type { Controller } from "./control.js";
import { dispatch, type RunnerCommand, type RunnerEvent } from "./dispatch.js";

// The minimal socket the channel needs, so the global WebSocket is swappable in tests.
export interface ChannelSocket {
    readonly send: (data: string) => void;
    readonly close: () => void;
    readonly onOpen: (callback: () => void) => void;
    readonly onMessage: (callback: (data: string) => void) => void;
    readonly onClose: (callback: () => void) => void;
}
export type Dialer = (url: string) => ChannelSocket;

// Wrap the Node-global WebSocket (Node 24) in the ChannelSocket shape. `error` is folded into `close` so the
// reconnect path is single — a failed/closed socket both trigger a redial.
const defaultDialer: Dialer = (url) => {
    const ws = new WebSocket(url);
    return {
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onOpen: (callback) => ws.addEventListener(`open`, () => callback()),
        onMessage: (callback) =>
            ws.addEventListener(`message`, (event) => callback(typeof event.data === `string` ? event.data : String(event.data))),
        onClose: (callback) => {
            ws.addEventListener(`close`, () => callback());
            ws.addEventListener(`error`, () => callback());
        },
    };
};

export interface ChannelOptions {
    // The platform WSS gateway (full url); the token rides as a query param (the WHATWG client has no headers).
    readonly url: string;
    readonly token: string;
    readonly controller: Controller;
    readonly signal: AbortSignal;
    readonly dial?: Dialer;
    readonly log?: (message: string) => void;
}

// Execute one platform command against the controller and stream its events back, tagged with the command's
// requestId so the platform can multiplex many concurrent commands over the single socket. dispatch already
// terminates with a `done`/`error` event; a thrown error is reported as one more `error` event.
const handleMessage = async (socket: ChannelSocket, data: string, controller: Controller): Promise<void> => {
    let frame: { requestId?: unknown; command?: unknown };
    try {
        frame = JSON.parse(data) as { requestId?: unknown; command?: unknown };
    } catch {
        return;
    }
    const requestId = frame.requestId;
    if (typeof requestId !== `string` || typeof frame.command !== `object` || frame.command === null) {
        return;
    }
    const send = (event: RunnerEvent): void => socket.send(JSON.stringify({ requestId, event }));
    try {
        for await (const event of dispatch(frame.command as RunnerCommand, controller)) {
            send(event);
        }
    } catch (error) {
        send({ kind: `error`, message: error instanceof Error ? error.message : `command failed` });
    }
};

// Maintain a persistent outbound connection to the platform gateway: dial, run commands via dispatch, and
// reconnect with capped exponential backoff until the signal aborts. The runner is the dialer — no inbound
// port — and one socket carries every sandbox command for this host.
export const connectChannel = (options: ChannelOptions): void => {
    const dial = options.dial ?? defaultDialer;
    const log = options.log ?? (() => {});
    let attempt = 0;
    let stopped = false;

    const open = (): void => {
        if (stopped) {
            return;
        }
        const separator = options.url.includes(`?`) ? `&` : `?`;
        const socket = dial(`${options.url}${separator}token=${encodeURIComponent(options.token)}`);
        socket.onOpen(() => {
            attempt = 0;
            log(`channel: connected to ${options.url}`);
        });
        socket.onMessage((data) => {
            void handleMessage(socket, data, options.controller);
        });
        socket.onClose(() => {
            if (stopped) {
                return;
            }
            attempt += 1;
            const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
            log(`channel: disconnected — reconnecting in ${delay}ms`);
            setTimeout(open, delay);
        });
    };

    options.signal.addEventListener(`abort`, () => {
        stopped = true;
    });
    open();
};
