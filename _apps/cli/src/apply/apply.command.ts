import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyMoves, createStore, type PruneOutcome, prune, reconcile, resolveInputs, rewriteGraphForMoves } from "@intentic/engine";
import { createProviders, createSshExecutor, createSshProbe, hostTarget } from "@intentic/providers";
import { buildCommand, type CommandContext, numberParser } from "@stricli/core";
import { ACCESS_FILE, ARTIFACT_PATH, LAST_APPLIED_FILE, loadEnvFile, readArtifact, STATUS_FILE, writeStatus } from "../lib/artifact.js";
import { createKnownHostsStore } from "../lib/known-hosts.js";
import { createOutput, outputMode } from "../lib/output.js";
import { ensureGeneratedSecrets } from "../secrets/generated-secrets.js";
import { generatedSecretStore } from "../secrets/secret-store.js";
import { collectSecrets } from "../secrets/secrets.js";
import { collectAccess, formatAccessSummary, writeAccessFile } from "./access.js";
import { acquireApplyLock } from "./apply-lock.js";
import { detectHostMoves, migrateHosts } from "./migrate.js";

const DEFAULT_MAX_ITERATIONS = 5;

interface ApplyFlags {
    readonly artifact?: string;
    readonly maxIterations?: number;
    readonly previous?: string;
}

export const apply = buildCommand<ApplyFlags>({
    docs: { brief: "Execute the desired-state artifact until state reads true" },
    parameters: {
        flags: {
            artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` },
            maxIterations: {
                kind: "parsed",
                parse: numberParser,
                optional: true,
                brief: `Max reconcile iterations (default ${DEFAULT_MAX_ITERATIONS})`,
            },
            previous: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Path to the last successfully-applied artifact; resources absent from the new one are pruned after convergence",
            },
        },
    },
    async func(this: CommandContext, flags: ApplyFlags) {
        const out = createOutput(this.process.stdout, outputMode(process.env));
        const artifact = flags.artifact ?? ARTIFACT_PATH;
        const dir = dirname(artifact);
        loadEnvFile(dir);
        const graph = await readArtifact(artifact);
        const ssh = createSshExecutor(createKnownHostsStore(dir));
        // The last successfully-applied artifact: the shared baseline for host-migration detection (a host
        // whose address changed moved machines) and for prune below. A moved host is migrated before reconcile
        // so its data lands on the new machine; its old machine is also locked so no concurrent run mutates it.
        const previousPath = flags.previous ?? join(dir, LAST_APPLIED_FILE);
        const previous = existsSync(previousPath) ? await readArtifact(previousPath) : undefined;
        const hostMoves = previous !== undefined ? detectHostMoves(previous, graph) : [];
        // Readiness gates target host-internal urls (http://<internalIp>:<port>) reachable only from the host
        // itself, never from this CLI process. Build SSH probes from every host node in the graph so apply
        // gates on each host's own view; resolveInputs substitutes SSH_KEY secrets from the env loaded above.
        // The composite probe tries each host until one can reach the URL (the wrong host simply fails wget).
        const targets = Object.values(graph.resources)
            .filter((node) => node.type === "host")
            .map((node) => hostTarget(resolveInputs(node.inputs, createStore(), process.env, { lenient: false })));
        const probes = targets.map((target) => createSshProbe(target, ssh));
        const probe =
            probes.length === 0
                ? undefined
                : async (url: string, status: number): Promise<boolean> => {
                      for (const p of probes) {
                          if (await p(url, status)) {
                              return true;
                          }
                      }
                      return false;
                  };
        // Serialize this apply (and the prune that follows) against every host the graph touches, so a
        // concurrent run cannot interleave mutations. Released in `finally`; a hard crash leaves the lock to
        // free via its TTL. A SIGINT/SIGTERM handler releases on Ctrl-C before exiting.
        // Lock every host the graph touches PLUS the old machine of any moved host, so neither end of a
        // migration can be mutated by a concurrent run.
        const oldMoveTargets = hostMoves.map((move) =>
            hostTarget(resolveInputs(move.oldNode.inputs, createStore(), process.env, { lenient: false })),
        );
        const lock = await acquireApplyLock(ssh, [...targets, ...oldMoveTargets], { log: out.log });
        const onSignal = (): void => {
            void lock.release().finally(() => process.exit(130));
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
            // Mint/read generated secrets UNDER the lock, against the host-authoritative store (backfill on, so a
            // value minted locally before the host existed is promoted to it). Under the lock this is the only
            // run minting, so two operators can never bake divergent admin passwords into Forgejo/Komodo.
            await ensureGeneratedSecrets(generatedSecretStore(graph, dir, ssh, true, out.log), collectSecrets(graph).generated, process.env);
            // A host whose address changed moved machines: snapshot the old host and stream its data to the new
            // one BEFORE reconcile, so its services come up on the new machine atop migrated data, not an empty
            // disk. RESTIC_PASSWORD is in env now (ensureGeneratedSecrets above), so restore decrypts the repo.
            if (hostMoves.length > 0) {
                await migrateHosts(hostMoves, { next: graph, ssh, env: process.env, tmpDir: tmpdir(), log: out.log });
            }
            // Consume any authored renames BEFORE reconcile: re-stamp each moved resource in place so reconcile
            // sees it as already-present (a noop) instead of orphaning the old id and recreating the new one.
            const movedApplied = await applyMoves(graph, {
                providers: createProviders({ ssh }),
                log: out.log,
                onEvent: out.onEvent,
                env: process.env,
            });
            const result = await reconcile(
                graph,
                { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, ...(probe !== undefined ? { probe } : {}) },
                { maxIterations: flags.maxIterations ?? DEFAULT_MAX_ITERATIONS },
            );
            await writeStatus(join(dir, STATUS_FILE), {
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
            });
            // Prune AFTER convergence (reconcile throws if it never converges, so a failed apply never deletes):
            // tear down every resource in the last successfully-applied artifact that the new one no longer
            // declares. Deletes need the kept platform nodes' creds, hence the same providers/env as the apply.
            // When --previous isn't explicit, auto-read the .last-applied.json snapshot from the last successful run.
            let pruned: PruneOutcome = { deleted: [], skipped: [] };
            if (previous !== undefined) {
                // Prune is the destructive phase: push the takeover deadline out for a long apply, then confirm
                // we still hold every lock before deleting anything (abort if another run took over).
                await lock.renew();
                await lock.verify();
                // Rewrite the baseline for in-place renames so prune treats a moved id as "became", not
                // "removed" — otherwise it would delete the resource we just re-stamped.
                const baseline = rewriteGraphForMoves(previous, movedApplied);
                pruned = await prune(baseline, graph, { providers: createProviders({ ssh }), log: out.log, onEvent: out.onEvent, env: process.env });
                if (pruned.deleted.length > 0 || pruned.skipped.length > 0) {
                    out.text(
                        `pruned ${pruned.deleted.length} resource(s)${pruned.skipped.length > 0 ? `, ${pruned.skipped.length} left in place` : ""}`,
                    );
                }
            }
            // Snapshot the current artifact so the next apply can prune against it.
            await writeFile(join(dir, LAST_APPLIED_FILE), await readFile(artifact, "utf8"));
            const access = collectAccess(graph, result.outcome.outputs, process.env);
            out.text(`${result.converged ? "converged" : "did not converge"} in ${result.iterations} iteration(s)`);
            if (access.length > 0) {
                await writeAccessFile(join(dir, ACCESS_FILE), access);
                out.text(formatAccessSummary(access));
            }
            out.result({
                converged: result.converged,
                iterations: result.iterations,
                steps: result.outcome.steps,
                outputs: result.outcome.outputs,
                orphans: result.outcome.orphans,
                pruned,
                access,
            });
            // Post a reconcile summary to the Discord #reconcile channel if the graph has a discord resource.
            const reconcileWebhook = result.outcome.outputs["discord"]?.["reconcileWebhook"];
            if (typeof reconcileWebhook === "string" && reconcileWebhook !== "") {
                const creates = result.outcome.steps.filter((s) => s.action === "create").length;
                const updates = result.outcome.steps.filter((s) => s.action === "update").length;
                const noops = result.outcome.steps.filter((s) => s.action === "noop").length;
                const summary = [
                    `**intentic apply** — ${result.converged ? "✅ converged" : "⚠️ did not converge"} in ${result.iterations} iteration(s)`,
                    `📊 ${result.outcome.steps.length} resources: ${creates} created, ${updates} updated, ${noops} unchanged`,
                    ...(result.outcome.orphans.length > 0 ? [`🗑️ ${result.outcome.orphans.length} orphan(s) detected`] : []),
                ].join("\n");
                try {
                    await fetch(reconcileWebhook, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ content: summary }),
                    });
                } catch {
                    out.log("discord: failed to post reconcile summary (non-fatal)");
                }
            }
        } finally {
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            await lock.release();
        }
    },
});
