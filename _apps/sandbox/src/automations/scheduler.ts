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

export type WakeFn = typeof streamAgent;

// Run the guard command in the workspace root; exit 0 ⇒ wake. On failure the stderr/stdout tail becomes the
// run's detail ("Skipped by guard" in the UI). Plain process env — guards are sandbox scripts, not agent turns.
const runGuard = async (command: string, cwd: string): Promise<{ pass: boolean; detail?: string }> => {
    try {
        await execFileAsync("sh", ["-c", command], { cwd, timeout: GUARD_TIMEOUT_MS });
        return { pass: true };
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string };
        const detail = `${stderr ?? ""}${stdout ?? ""}`.trim().slice(-GUARD_DETAIL_TAIL);
        return { pass: false, ...(detail !== "" ? { detail } : {}) };
    }
};

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// Polls the automations manifest and fires whatever came due since the last pass — so edits are picked up with
// no resync bookkeeping. Fires run detached from the tick (an agent turn can outlast many polls); an automation
// never overlaps itself — occurrences that pass while its previous run is still going are dropped, not queued.
export const createAutomationsScheduler = (services: Services, wake: WakeFn = streamAgent, intervalMs = 30_000): AutomationsScheduler => {
    let since = Date.now();
    const inFlight = new Set<string>();
    let timer: NodeJS.Timeout | undefined;

    const fire = async (automation: AutomationRecord): Promise<void> => {
        if (automation.guard !== undefined) {
            const guard = await runGuard(automation.guard, services.workspace.root);
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
        let failure: string | undefined;
        for await (const event of wake(services, { prompt: automation.prompt }, undefined)) {
            if (event.kind === "error") {
                failure = event.message;
            }
        }
        await services.automations.recordRun(
            automation.id,
            failure === undefined ? { at: Date.now(), outcome: "completed" } : { at: Date.now(), outcome: "error", detail: failure },
        );
    };

    const tick = async (now = Date.now()): Promise<void> => {
        const windowStart = since;
        since = now;
        for (const automation of await services.automations.list()) {
            if (!automation.enabled || inFlight.has(automation.id)) {
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
            inFlight.add(automation.id);
            void fire(automation)
                .catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"))
                .finally(() => inFlight.delete(automation.id));
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
