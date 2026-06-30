import type { EngineEvent } from "@intentic/engine";

// How a command renders: human prose (default), one JSON document at the end, or a live NDJSON event
// stream. Selected by INTENTIC_OUTPUT so a backend driving the CLI as a subprocess sets it once; humans
// get `text` unchanged.
export type OutputMode = "text" | "json" | "ndjson";

export const outputMode = (env: Readonly<Record<string, string | undefined>>): OutputMode => {
    const value = env["INTENTIC_OUTPUT"];
    return value === "json" || value === "ndjson" ? value : "text";
};

interface Sink {
    readonly write: (chunk: string) => void;
}

// The single seam every command renders through. `onEvent`/`log` feed the engine (structured lifecycle
// events and providers' free-form strings); `text` is a human summary line; `result` is the final
// structured payload. Each method's behavior is decided by the mode. Failures are left to propagate —
// stricli renders them on stderr and sets a non-zero exit code, and a stream consumer still has the
// events emitted before the throw plus the exit code.
export interface Output {
    readonly mode: OutputMode;
    readonly onEvent: (event: EngineEvent) => void;
    readonly log: (message: string) => void;
    readonly text: (line: string) => void;
    readonly result: (result: Record<string, unknown>) => void;
}

// The text rendering of the lifecycle events that text mode used to print (prune/orphan, verbatim). The
// progress-only events (node/readiness/iteration) stay silent in text mode — they exist for the stream.
const eventText = (event: EngineEvent): string | undefined => {
    if (event.kind === "prune") {
        return event.state === "deleted"
            ? `prune: deleted "${event.id}" (type "${event.type}")`
            : `prune: "${event.id}" (type "${event.type}") removed from desired state but its provider has no delete — left in place`;
    }
    if (event.kind === "orphan") {
        return `orphan: "${event.id}" (type "${event.type}") exists but is not in the desired graph — not deleted`;
    }
    return undefined;
};

export const createOutput = (sink: Sink, mode: OutputMode): Output => {
    const line = (text: string): void => sink.write(`${text}\n`);
    const jsonLine = (value: unknown): void => sink.write(`${JSON.stringify(value)}\n`);

    if (mode === "ndjson") {
        return {
            mode,
            onEvent: jsonLine,
            log: (message) => jsonLine({ kind: "log", message }),
            text: () => {},
            result: (result) => jsonLine({ kind: "result", ...result }),
        };
    }

    if (mode === "json") {
        // Silent during the run; one document at the end.
        return {
            mode,
            onEvent: () => {},
            log: () => {},
            text: () => {},
            result: (result) => sink.write(`${JSON.stringify(result, undefined, 4)}\n`),
        };
    }

    // text: the human default — identical to the CLI's prior output.
    return {
        mode,
        onEvent: (event) => {
            const text = eventText(event);
            if (text !== undefined) {
                line(text);
            }
        },
        log: line,
        text: line,
        result: () => {}, // already printed via text()/onEvent()
    };
};
