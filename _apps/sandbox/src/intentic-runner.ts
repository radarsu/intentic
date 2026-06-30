import { spawn } from "node:child_process";
import type { IntenticLine } from "@intentic/sandbox-contract";

// `IntenticLine` (one parsed line from `intentic … --output ndjson`: engine events, provider `log`, the
// terminal `result`) is the wire shape the daemon streams, so it lives in @intentic/sandbox-contract. It stays
// structurally decoupled from @intentic/engine: the sandbox runs a pinned intentic binary in a separate
// process, so it consumes the wire shape, not the engine types.

// Parse a single ndjson line. Blank lines yield undefined; a non-object or one without a string `kind` is
// not a valid event and yields undefined. Malformed JSON throws (it would be a real contract violation).
export const parseIntenticLine = (line: string): IntenticLine | undefined => {
    const trimmed = line.trim();
    if (trimmed === "") {
        return undefined;
    }
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const kind = (value as { kind?: unknown }).kind;
    return typeof kind === "string" ? (value as IntenticLine) : undefined;
};

// Split a stream of arbitrary string chunks into newline-delimited lines, carrying a partial line across
// chunk boundaries and flushing any trailing remainder. Pure async transform — the unit-testable core of
// reading a subprocess's streamed stdout.
export async function* chunksToLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of chunks) {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            yield buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
        }
    }
    if (buffer !== "") {
        yield buffer;
    }
}

export interface IntenticRun {
    // The intentic subcommand + flags, e.g. ["resolve", "--config", "intent/deploy.config.ts"]. The runner
    // forces INTENTIC_OUTPUT=ndjson, so the command streams structured lines regardless of caller flags.
    readonly args: readonly string[];
    readonly cwd: string;
}

// Run the in-sandbox intentic CLI and stream its ndjson lines as they arrive (so the UI sees live
// resolve/plan progress). A non-zero exit propagates as an error once the stream ends, with captured stderr.
export async function* runIntentic(run: IntenticRun): AsyncGenerator<IntenticLine> {
    const child = spawn("intentic", [...run.args], { cwd: run.cwd, env: { ...process.env, INTENTIC_OUTPUT: "ndjson" } });
    child.stdout.setEncoding("utf8");
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    for await (const line of chunksToLines(child.stdout as AsyncIterable<string>)) {
        const parsed = parseIntenticLine(line);
        if (parsed !== undefined) {
            yield parsed;
        }
    }
    const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? 0)));
    if (code !== 0) {
        throw new Error(`intentic ${run.args.join(" ")} exited ${code}: ${stderr.trim()}`);
    }
}
