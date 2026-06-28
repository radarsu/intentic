import type { EngineEvent } from "@intentic/engine";
import { expect, test } from "vitest";
import { createOutput, outputMode } from "./output.js";

const sink = () => {
    const chunks: string[] = [];
    return { chunks, write: (chunk: string) => chunks.push(chunk) };
};

const pruneDeleted: EngineEvent = { kind: "prune", state: "deleted", id: "old", type: "forgejo" };
const nodeStart: EngineEvent = { kind: "node", phase: "apply", state: "start", id: "host", type: "host" };

test("outputMode reads INTENTIC_OUTPUT and defaults to text", () => {
    expect(outputMode({ INTENTIC_OUTPUT: "json" })).toBe("json");
    expect(outputMode({ INTENTIC_OUTPUT: "ndjson" })).toBe("ndjson");
    expect(outputMode({ INTENTIC_OUTPUT: "garbage" })).toBe("text");
    expect(outputMode({})).toBe("text");
});

test("text mode renders prune/orphan events as the human strings and stays silent on progress events", () => {
    const s = sink();
    const out = createOutput(s, "text");
    out.onEvent(pruneDeleted);
    out.onEvent(nodeStart); // progress-only — silent in text
    out.log("provider says hi");
    out.text("converged in 1 iteration(s)");
    out.result({ converged: true }); // text already printed; result is a no-op
    expect(s.chunks).toEqual([`prune: deleted "old" (type "forgejo")\n`, "provider says hi\n", "converged in 1 iteration(s)\n"]);
});

test("ndjson mode emits one JSON object per event, log, and a terminal result", () => {
    const s = sink();
    const out = createOutput(s, "ndjson");
    out.onEvent(nodeStart);
    out.log("provider says hi");
    out.text("ignored in ndjson");
    out.result({ converged: true, iterations: 1 });
    const parsed = s.chunks.map((chunk) => JSON.parse(chunk));
    expect(parsed).toEqual([
        { kind: "node", phase: "apply", state: "start", id: "host", type: "host" },
        { kind: "log", message: "provider says hi" },
        { kind: "result", converged: true, iterations: 1 },
    ]);
});

test("json mode is silent during the run and emits one document at the end", () => {
    const s = sink();
    const out = createOutput(s, "json");
    out.onEvent(nodeStart);
    out.log("provider says hi");
    out.text("ignored in json");
    out.result({ converged: true, iterations: 1 });
    expect(s.chunks).toHaveLength(1);
    expect(JSON.parse(s.chunks[0] ?? "")).toEqual({ converged: true, iterations: 1 });
});
