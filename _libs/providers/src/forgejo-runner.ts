import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

const runnerSchema = sshSchema.extend({ instanceUrl: z.string(), token: z.string() });
type RunnerInputs = z.infer<typeof runnerSchema>;
const parse = (inputs: ResolvedInputs): RunnerInputs => parseInputs(runnerSchema, inputs, "forgejo-runner");

const CONTAINER = "intentic-forgejo-runner";
const IMAGE = "data.forgejo.org/forgejo/runner:6";

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

// A registered runner writes /data/.runner recording the instance it is bound to. If that file is missing
// or bound to a different instance (e.g. the forgejo url changed), the runner must re-register.
const registeredTo = async (session: SshSession, instanceUrl: string): Promise<boolean> => {
    const result = await session.exec(`docker exec ${CONTAINER} cat /data/.runner 2>/dev/null || true`);
    return result.stdout.includes(instanceUrl);
};

// The Forgejo Actions runner (act_runner) for a host, registered against the host's Forgejo with the
// platform's runner token. No outputs (it is a worker). read returns the resource only when the container
// is up and registered to the desired instance; apply is idempotent — the persistent token lets the same
// registration repeat safely.
export const createForgejoRunnerProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`forgejo-runner "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session)) || !(await registeredTo(session, parsed.instanceUrl))) {
                return undefined;
            }
            return { outputs: {} };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                // --user root: the runner executes jobs via the mounted docker socket; its default non-root
                // user gets "permission denied" on /var/run/docker.sock, so the daemon crash-loops.
                `docker run -d --restart unless-stopped --network host --user root --name ${CONTAINER} --label intentic.id=${ctx.id} ` +
                    `-v ${CONTAINER}-data:/data -v /var/run/docker.sock:/var/run/docker.sock ${IMAGE} ` +
                    `sh -c "forgejo-runner register --no-interactive --instance ${parsed.instanceUrl} --token ${parsed.token} && forgejo-runner daemon"`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start forgejo-runner on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return {};
        } finally {
            await session.dispose();
        }
    },
});
