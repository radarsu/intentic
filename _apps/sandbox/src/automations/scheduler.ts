import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cron } from "croner";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { AutomationRecord } from "./automations-store.js";

const execFileAsync = promisify(execFile);

// How long a guard command may run before it counts as failed (skipping the wake).
const GUARD_TIMEOUT_MS = 60_000;
// How much guard output survives into the run's detail.
const GUARD_DETAIL_TAIL = 500;
// How much of an event's webhook body reaches the guard's env and the wake prompt.
export const PAYLOAD_MAX = 64_000;

export type WakeFn = typeof streamAgent;

// Run the guard command in the workspace root; exit 0 ⇒ wake. An event's payload is in AUTOMATION_PAYLOAD so
// guards can filter on it. On failure the stderr/stdout tail becomes the run's detail ("Skipped by guard" in
// the UI). Plain process env otherwise — guards are sandbox scripts, not agent turns.
const runGuard = async (command: string, cwd: string, payload: string | undefined): Promise<{ pass: boolean; detail?: string }> => {
    try {
        await execFileAsync("sh", ["-c", command], {
            cwd,
            timeout: GUARD_TIMEOUT_MS,
            env: { ...process.env, ...(payload !== undefined ? { AUTOMATION_PAYLOAD: payload } : {}) },
        });
        return { pass: true };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-GUARD_DETAIL_TAIL);
        return { pass: false, ...(detail !== "" ? { detail } : {}) };
    }
};

// An automation never overlaps itself — cron occurrences or webhook events that arrive while its previous run
// is still going are dropped, not queued. A module singleton (like agent-requests' bridge) so the scheduler's
// tick and the /automations/{id}/fire route share it.
const inFlight = new Set<string>();

// Fire one automation now: guard (payload visible) → wake the agent (payload appended to the prompt) → record
// the run. Callers run it detached from their tick/request lifecycles; tests await it directly.
export const fireAutomation = async (
    services: Services,
    automation: AutomationRecord,
    payload?: string,
    wake: WakeFn = streamAgent,
): Promise<void> => {
    if (inFlight.has(automation.id)) {
        return;
    }
    inFlight.add(automation.id);
    try {
        const capped = payload?.slice(0, PAYLOAD_MAX);
        if (automation.guard !== undefined) {
            const guard = await runGuard(automation.guard, services.workspace.root, capped);
            if (!guard.pass) {
                await services.automations.recordRun(automation.id, {
                    at: Date.now(),
                    outcome: "skipped",
                    ...(guard.detail !== undefined ? { detail: guard.detail } : {}),
                });
                return;
            }
        }
        // Each wake is a fresh headless turn; its transcript lands in the workspace sessions like a chat turn.
        const prompt = capped !== undefined && capped !== "" ? `${automation.prompt}\n\n--- Event payload ---\n${capped}` : automation.prompt;
        let failure: string | undefined;
        for await (const event of wake(services, { prompt }, undefined)) {
            if (event.kind === "error") {
                failure = event.message;
            }
        }
        await services.automations.recordRun(
            automation.id,
            failure === undefined ? { at: Date.now(), outcome: "completed" } : { at: Date.now(), outcome: "error", detail: failure },
        );
    } finally {
        inFlight.delete(automation.id);
    }
};

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// Polls the automations manifest and fires whatever came due since the last pass — so edits are picked up with
// no resync bookkeeping. Fires run detached from the tick (an agent turn can outlast many polls). Event-kind
// automations don't tick; they fire from the /automations/{id}/fire route.
export const createAutomationsScheduler = (services: Services, wake: WakeFn = streamAgent, intervalMs = 30_000): AutomationsScheduler => {
    let since = Date.now();
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now = Date.now()): Promise<void> => {
        const windowStart = since;
        since = now;
        for (const automation of await services.automations.list()) {
            if (!automation.enabled || automation.trigger.kind !== "schedule") {
                continue;
            }
            // A cron hand-edited into invalidity only silences its own automation, never the tick.
            let due: Date | null;
            try {
                due = new Cron(automation.trigger.cron).nextRun(new Date(windowStart));
            } catch {
                continue;
            }
            if (due === null || due.getTime() > now) {
                continue;
            }
            void fireAutomation(services, automation, undefined, wake).catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id }, "automation run failed"),
            );
        }
    };

    return {
        tick,
        start: () => {
            timer = setInterval(() => void tick(), intervalMs);
        },
        stop: () => clearInterval(timer),
    };
};
