import type { Controller } from "./control.js";
import type { Sandbox } from "./sandbox-manager.js";

// The command/event protocol the platform speaks to the runner. `kind`-discriminated like the rest of the
// system; the Phase-3 gateway encodes RunnerCommand over the outbound WS channel and decodes RunnerEvent.
export type RunnerCommand =
    | { readonly kind: "ensure" }
    | { readonly kind: "remove" }
    | { readonly kind: "status" }
    | { readonly kind: "relay"; readonly path: string; readonly init?: RequestInit };

export type RunnerEvent =
    | { readonly kind: "status"; readonly running: boolean; readonly image?: string; readonly sandbox?: Sandbox }
    | { readonly kind: "stream"; readonly line: string }
    | { readonly kind: "done" }
    | { readonly kind: "error"; readonly message: string };

// Execute one command against the controller, yielding its events. relay → stream lines then done;
// lifecycle → a status then done; any failure → a single error (failures are reported, not thrown, so the
// channel can forward them to the UI without tearing down).
export async function* dispatch(command: RunnerCommand, controller: Controller): AsyncGenerator<RunnerEvent> {
    try {
        if (command.kind === "ensure") {
            const sandbox = await controller.ensure();
            yield { kind: "status", running: true, sandbox };
            yield { kind: "done" };
            return;
        }
        if (command.kind === "remove") {
            await controller.remove();
            yield { kind: "status", running: false };
            yield { kind: "done" };
            return;
        }
        if (command.kind === "status") {
            const state = await controller.status();
            yield { kind: "status", running: state.running, ...(state.image !== undefined ? { image: state.image } : {}) };
            yield { kind: "done" };
            return;
        }
        for await (const line of controller.relay(command.path, command.init)) {
            yield { kind: "stream", line };
        }
        yield { kind: "done" };
    } catch (error) {
        yield { kind: "error", message: error instanceof Error ? error.message : "runner command failed" };
    }
}
