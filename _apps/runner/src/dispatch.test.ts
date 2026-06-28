import { expect, test } from "vitest";
import type { Controller } from "./control.js";
import { dispatch, type RunnerCommand, type RunnerEvent } from "./dispatch.js";

const sandbox = { name: "intentic-sandbox-acme", daemonUrl: "http://intentic-sandbox-acme:8787", devPort: 5173 };

const fakeController = (overrides: Partial<Controller> = {}): Controller => ({
    ensure: async () => sandbox,
    remove: async () => {},
    status: async () => ({ running: true, image: "intentic/sandbox:1" }),
    relay: async function* () {
        yield "data: a";
        yield "data: b";
    },
    ...overrides,
});

const run = async (command: RunnerCommand, controller: Controller): Promise<RunnerEvent[]> => {
    const events: RunnerEvent[] = [];
    for await (const event of dispatch(command, controller)) {
        events.push(event);
    }
    return events;
};

test("ensure yields a running status with the sandbox, then done", async () => {
    expect(await run({ kind: "ensure" }, fakeController())).toEqual([{ kind: "status", running: true, sandbox }, { kind: "done" }]);
});

test("status reflects the container state", async () => {
    expect(await run({ kind: "status" }, fakeController())).toEqual([
        { kind: "status", running: true, image: "intentic/sandbox:1" },
        { kind: "done" },
    ]);
});

test("relay yields each daemon line as a stream event, then done", async () => {
    expect(await run({ kind: "relay", path: "/agent" }, fakeController())).toEqual([
        { kind: "stream", line: "data: a" },
        { kind: "stream", line: "data: b" },
        { kind: "done" },
    ]);
});

test("a failing command yields a single error event", async () => {
    const controller = fakeController({
        ensure: async () => {
            throw new Error("docker down");
        },
    });
    expect(await run({ kind: "ensure" }, controller)).toEqual([{ kind: "error", message: "docker down" }]);
});
