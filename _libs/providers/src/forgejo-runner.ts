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
const CONFIG_DIR = "/opt/intentic/runner";
// The image act_runner runs each `runs-on: docker` job in. It carries node (the JS actions need it); the
// docker CLI + buildx are bind-mounted from the host (below) so jobs build against the host daemon.
const JOB_IMAGE = "data.forgejo.org/oci/node:20-bullseye";

// act_runner config so each job container builds with the HOST docker: host networking + the daemon socket
// auto-mounted (docker_host: automount) + the host's static docker CLI and buildx plugin bind-mounted in, so
// the CI workflow's docker/* actions push to localhost:3000 via the host daemon and the notify step reaches
// Komodo's host-internal url. dockerBin/buildxPlugin are discovered on the host (paths vary by distro).
const runnerConfig = (dockerBin: string, buildxPlugin: string): string =>
    [
        "runner:",
        `  labels: [ "docker:docker://${JOB_IMAGE}" ]`,
        "container:",
        "  network: host",
        "  docker_host: automount",
        `  options: -v ${dockerBin}:/usr/local/bin/docker:ro -v ${buildxPlugin}:/usr/local/lib/docker/cli-plugins/docker-buildx:ro`,
        "  valid_volumes:",
        `    - ${dockerBin}`,
        `    - ${buildxPlugin}`,
        "",
    ].join("\n");

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
            // CI builds the app image with the HOST docker daemon, so each job container needs the docker CLI +
            // buildx plugin. Both are static binaries — discover them on the host and bind-mount them into jobs
            // (via the runner config) instead of pulling a multi-GB docker-in-node image.
            const dockerBin = (await session.exec("command -v docker")).stdout.trim();
            if (dockerBin === "") {
                throw new Error("forgejo-runner: no docker CLI found on the host (CI builds the app image with the host daemon)");
            }
            const buildxPlugin = (
                await session.exec(
                    "find /usr/local/libexec/docker/cli-plugins /usr/libexec/docker/cli-plugins /usr/lib/docker/cli-plugins /usr/local/lib/docker/cli-plugins -name docker-buildx 2>/dev/null | head -1",
                )
            ).stdout.trim();
            if (buildxPlugin === "") {
                throw new Error("forgejo-runner: no docker buildx plugin found on the host (the CI build-push step needs it)");
            }
            await session.exec(`mkdir -p ${CONFIG_DIR}`);
            await session.exec(`cat > ${CONFIG_DIR}/config.yaml <<'CFG'\n${runnerConfig(dockerBin, buildxPlugin)}CFG`);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                // --user root: the runner executes jobs via the mounted docker socket; its default non-root user
                // gets "permission denied" on /var/run/docker.sock, so the daemon crash-loops. --config points
                // both register + daemon at the config that wires the host docker into job containers.
                `docker run -d --restart unless-stopped --network host --user root --name ${CONTAINER} --label intentic.id=${ctx.id} ` +
                    `-v ${CONTAINER}-data:/data -v /var/run/docker.sock:/var/run/docker.sock -v ${CONFIG_DIR}/config.yaml:/config.yaml:ro ${IMAGE} ` +
                    `sh -c "forgejo-runner register --no-interactive --config /config.yaml --instance ${parsed.instanceUrl} --token ${parsed.token} && forgejo-runner daemon --config /config.yaml"`,
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
