import { spawn } from "node:child_process";
import type { ScriptLine, ScriptParam } from "@intentic/sandbox-contract";
import { chunksToLines } from "../intentic/intentic-runner.js";

export const SCRIPT_TIMEOUT_MS = 600_000;

// Validate submitted values against the declared params and build the env slice the run receives: unknown keys
// and type mismatches are rejected, select values must be members, defaults fill absences, and a required param
// without a value throws. Everything stringifies HERE — booleans as "true"/"false", numbers as decimal strings —
// so the shell only ever sees strings and the daemon can still reject "abc" for a number param cleanly. Throws
// plain Error; the route maps it to BAD_REQUEST.
export const buildScriptEnv = (params: readonly ScriptParam[], values: Record<string, string | number | boolean>): Record<string, string> => {
    const declared = new Set(params.map((param) => param.name));
    for (const key of Object.keys(values)) {
        if (!declared.has(key)) {
            throw new Error(`unknown param "${key}"`);
        }
    }
    const env: Record<string, string> = {};
    for (const param of params) {
        const value = values[param.name] ?? param.default;
        if (value === undefined) {
            if (param.required === true) {
                throw new Error(`missing required param "${param.name}"`);
            }
            continue;
        }
        const expected = param.type === "select" ? "string" : param.type;
        if (typeof value !== expected) {
            throw new Error(`param "${param.name}" must be a ${expected}`);
        }
        if (param.type === "select" && !param.options.includes(value as string)) {
            throw new Error(`param "${param.name}" must be one of: ${param.options.join(", ")}`);
        }
        env[param.name] = String(value);
    }
    return env;
};

export interface ScriptExecution {
    readonly command: string;
    // Already workspace-contained by resolveWithin at the call site.
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeoutMs: number;
}

// Run the command via `sh -c` (params ride the env — never interpolated into the command) and stream stdout/
// stderr LINES as frames in arrival order, terminated by an `exit` frame. A timeout/signal kill has no exit
// code, so it yields an `error` frame instead. Unlike runIntentic this keeps stderr live (a script's progress
// often goes there) — both pipes feed one queue the generator drains.
export async function* runScript(run: ScriptExecution): AsyncGenerator<ScriptLine> {
    const child = spawn("sh", ["-c", run.command], {
        cwd: run.cwd,
        env: { ...process.env, ...run.env },
        timeout: run.timeoutMs,
        killSignal: "SIGKILL",
    });
    const frames: ScriptLine[] = [];
    let ended = false;
    let notify: (() => void) | undefined;
    const push = (frame: ScriptLine): void => {
        frames.push(frame);
        notify?.();
    };
    const end = (): void => {
        ended = true;
        notify?.();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const pump = async (pipe: AsyncIterable<string>, kind: "stdout" | "stderr"): Promise<void> => {
        for await (const text of chunksToLines(pipe)) {
            push({ kind, text });
        }
    };
    const pumps = Promise.all([pump(child.stdout as AsyncIterable<string>, "stdout"), pump(child.stderr as AsyncIterable<string>, "stderr")]);
    child.on("error", (error) => {
        push({ kind: "error", message: error.message });
        end();
    });
    // `close` fires after both stdio streams end, but chain on the pumps anyway so the terminal frame always
    // trails the last output line.
    child.on("close", (code, signal) => {
        void pumps.then(() => {
            if (code !== null) {
                push({ kind: "exit", code });
            } else {
                push({ kind: "error", message: `killed by ${signal ?? "signal"} (timeout after ${run.timeoutMs}ms?)` });
            }
            end();
        });
    });

    while (true) {
        const frame = frames.shift();
        if (frame !== undefined) {
            yield frame;
            continue;
        }
        if (ended) {
            return;
        }
        await new Promise<void>((resolve) => {
            notify = resolve;
        });
        notify = undefined;
    }
}
