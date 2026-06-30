import { createHash } from "node:crypto";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor, SshSession } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

// One agent MCP tool, resolved: a remote endpoint reached by URL with a scoped bearer. The engine resolves
// the token secret before this provider runs, so `token` is the concrete string here.
const toolSchema = z.object({ name: z.string(), url: z.string(), token: z.string() });

const workspaceSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    zone: z.string(),
    devPort: z.coerce.number(),
    daemonPort: z.coerce.number(),
    devCommand: z.string(),
    network: z.string(),
    image: z.string(),
    // Anthropic-compatible base URL the sandbox reads as ANTHROPIC_BASE_URL for the agent; absent ⇒ cloud.
    agentBaseUrl: z.string().optional(),
    // The agent's MCP tools (intent-declared internal services), forwarded into the sandbox as the agent's
    // remote MCP servers. Absent ⇒ no tools.
    tools: z.array(toolSchema).optional(),
});
type WorkspaceInputs = z.infer<typeof workspaceSchema>;
const parse = (inputs: ResolvedInputs): WorkspaceInputs => parseInputs(workspaceSchema, inputs, "workspace");

// One sandbox per host (like the platform's Forgejo/Komodo) — a fixed name + workspace volume, matching the
// connect.sh local flow so the two bootstraps stay in lockstep.
const CONTAINER = "intentic-sandbox-workspace";
const WORKSPACE_VOLUME = "intentic-workspace-workspace";

// A stable digest of the resolved tools, stamped as a container label so a tools change (not just an image
// bump) triggers a recreate. Empty when no tools are wired.
const toolsDigest = (tools: WorkspaceInputs["tools"]): string =>
    tools === undefined || tools.length === 0 ? "" : createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);

const internalUrl = (parsed: WorkspaceInputs): string => `http://${parsed.internalIp}:${parsed.daemonPort}`;
const outputsFor = (parsed: WorkspaceInputs): Record<string, unknown> => ({
    internalUrl: internalUrl(parsed),
    healthUrl: `${internalUrl(parsed)}/health`,
    previewBase: `preview.${parsed.zone}`,
});

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

const runningImage = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

// The tools digest stamped on the running container (empty when the label is absent).
const runningToolsDigest = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{index .Config.Labels "intentic.tools"}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

// The per-host AI-agent workspace: one long-lived SANDBOX container (the workspace IS the sandbox now — no
// runner, no docker socket). It serves its dev server on `devPort`, which the host's wildcard `*.preview.<zone>`
// tunnel route points at; the daemon on `daemonPort` is host-internal (preview-only — connect.sh is the
// browser-direct path). read returns the resource only when the container runs the desired image; apply is
// idempotent — it ensures the shared network exists, then (re)creates the sandbox unprivileged with the
// workspace volume and both ports bound to the host's internal ip (so only the tunnel reaches them).
export const createWorkspaceProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`workspace "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session))) {
                return undefined;
            }
            return { outputs: outputsFor(parsed), detail: { image: await runningImage(session), tools: await runningToolsDigest(session) } };
        } finally {
            await session.dispose();
        }
    },
    // Recreate on a sandbox-image bump or an agent-tools change (the container is stateless aside from the
    // workspace volume, which persists across recreations).
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        if (observed.detail?.["image"] !== parsed.image) {
            return {
                action: "update",
                reason: `workspace sandbox image differs (running ${String(observed.detail?.["image"])}, want ${parsed.image})`,
            };
        }
        const wantTools = toolsDigest(parsed.tools);
        if (observed.detail?.["tools"] !== wantTools) {
            return {
                action: "update",
                reason: `workspace agent tools changed (running ${String(observed.detail?.["tools"])}, want ${wantTools})`,
            };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker network inspect ${parsed.network} >/dev/null 2>&1 || docker network create ${parsed.network}`);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            // Forwarded into the sandbox so the agent talks to a custom Anthropic endpoint.
            const agentEnv = parsed.agentBaseUrl !== undefined ? ` -e ANTHROPIC_BASE_URL=${parsed.agentBaseUrl}` : ``;
            // The agent's MCP tools, base64-encoded so the JSON (quotes/braces) rides the docker `-e` cleanly
            // through the SSH command. The daemon decodes + connects them for each agent turn.
            const digest = toolsDigest(parsed.tools);
            const toolsEnv =
                parsed.tools !== undefined && parsed.tools.length > 0
                    ? ` -e INTENTIC_AGENT_TOOLS=${Buffer.from(JSON.stringify(parsed.tools)).toString("base64")}`
                    : ``;
            const run = await session.exec(
                // Unprivileged: no --user root, no docker-socket mount (the sandbox no longer manages other
                // containers, it IS the workspace). Both ports bind the host's INTERNAL ip — cloudflared
                // (--network host) reaches the dev server there for the wildcard preview route, and the engine
                // health-probes the daemon, without exposing either on the host's public interface. The tools
                // digest label drives recreate-on-change. SANDBOX_NAME/SANDBOX_IMAGE feed the daemon's /info.
                `docker run -d --restart unless-stopped --name ${CONTAINER} --label intentic.id=${ctx.id} --label intentic.tools=${digest} ` +
                    `--network ${parsed.network} --add-host host.docker.internal:host-gateway ` +
                    `-p ${parsed.internalIp}:${parsed.devPort}:${parsed.devPort} -p ${parsed.internalIp}:${parsed.daemonPort}:${parsed.daemonPort} ` +
                    `-v ${WORKSPACE_VOLUME}:/work ` +
                    `-e WORKSPACE_ROOT=/work -e SANDBOX_HOST=0.0.0.0 -e SANDBOX_PORT=${parsed.daemonPort} ` +
                    `-e DEV_COMMAND='${parsed.devCommand}' -e DEV_PORT=${parsed.devPort} ` +
                    `-e SANDBOX_NAME=${CONTAINER} -e SANDBOX_IMAGE=${parsed.image}${agentEnv}${toolsEnv} ${parsed.image}`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start workspace sandbox on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
    },
});
