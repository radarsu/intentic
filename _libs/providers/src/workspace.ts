import { createHash } from "node:crypto";
import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

// One agent MCP tool, resolved: a remote endpoint reached by URL with a scoped bearer. The engine resolves
// the token secret before this provider runs, so `token` is the concrete string here.
const toolSchema = z.object({ name: z.string(), url: z.string(), token: z.string() });

const workspaceSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    zone: z.string(),
    previewPort: z.coerce.number(),
    network: z.string(),
    image: z.string(),
    sandboxImage: z.string(),
    // Set together (control-plane opt-in): the runner dials platformUrl with runnerToken. Absent ⇒ preview-only.
    platformUrl: z.string().optional(),
    runnerToken: z.string().optional(),
    // Anthropic-compatible base URL the runner exports as ANTHROPIC_BASE_URL into each sandbox; absent ⇒ cloud.
    agentBaseUrl: z.string().optional(),
    // The agent's MCP tools (intent-declared internal services); forwarded into each sandbox as the agent's
    // remote MCP servers. Absent ⇒ no tools.
    tools: z.array(toolSchema).optional(),
});
type WorkspaceInputs = z.infer<typeof workspaceSchema>;
const parse = (inputs: ResolvedInputs): WorkspaceInputs => parseInputs(workspaceSchema, inputs, "workspace");

const CONTAINER = "intentic-runner";

// A stable digest of the resolved tools, stamped as a container label so a tools change (not just an image
// bump) triggers a recreate. Empty when no tools are wired.
const toolsDigest = (tools: WorkspaceInputs["tools"]): string =>
    tools === undefined || tools.length === 0 ? "" : createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);

const internalUrl = (parsed: WorkspaceInputs): string => `http://${parsed.internalIp}:${parsed.previewPort}`;
const outputsFor = (parsed: WorkspaceInputs): Record<string, unknown> => ({
    internalUrl: internalUrl(parsed),
    healthUrl: `${internalUrl(parsed)}/healthz`,
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

// The tools digest stamped on the running container (empty when the label is absent — e.g. a pre-tools runner).
const runningToolsDigest = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`docker inspect --format '{{index .Config.Labels "intentic.tools"}}' ${CONTAINER} 2>/dev/null || true`);
    return result.stdout.trim();
};

// The per-host AI-agent workspace runner: one long-lived container that manages this host's project sandboxes
// (it holds the docker socket) and fronts previews on `previewPort` (the wildcard tunnel route points here).
// read returns the resource only when the container runs the desired image; apply is idempotent — it ensures
// the shared sandbox network exists, then (re)creates the runner with the socket mount + published port.
export const createWorkspaceRunnerProvider = (executor: SshExecutor = sshExecutor): Provider => ({
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
    // Recreate on a runner-image bump or an agent-tools change (the container is stateless — it reconstructs
    // sandboxes on demand, and each new sandbox picks up the forwarded tools).
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        if (observed.detail?.["image"] !== parsed.image) {
            return {
                action: "update",
                reason: `workspace runner image differs (running ${String(observed.detail?.["image"])}, want ${parsed.image})`,
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
            // The runner reaches each sandbox by container name on this shared network; create it before the run.
            await session.exec(`docker network inspect ${parsed.network} >/dev/null 2>&1 || docker network create ${parsed.network}`);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            // Control-plane env: present only when the workspace opted in (platformUrl set). The token is a
            // secret, so it rides the env list (the whole command runs over the SSH channel).
            const channelEnv =
                parsed.platformUrl !== undefined && parsed.runnerToken !== undefined
                    ? ` -e PLATFORM_URL=${parsed.platformUrl} -e RUNNER_TOKEN=${parsed.runnerToken}`
                    : ``;
            // Forwarded into each sandbox the runner spawns, so the agent talks to a custom Anthropic endpoint.
            const agentEnv = parsed.agentBaseUrl !== undefined ? ` -e ANTHROPIC_BASE_URL=${parsed.agentBaseUrl}` : ``;
            // The agent's MCP tools, base64-encoded so the JSON (quotes/braces) rides the docker `-e` cleanly
            // through the SSH command. The runner forwards it into each sandbox, which decodes + connects.
            const digest = toolsDigest(parsed.tools);
            const toolsEnv =
                parsed.tools !== undefined && parsed.tools.length > 0
                    ? ` -e INTENTIC_AGENT_TOOLS=${Buffer.from(JSON.stringify(parsed.tools)).toString("base64")}`
                    : ``;
            const run = await session.exec(
                // --user root: the runner manages sandboxes through the mounted docker socket (its default
                // non-root user gets "permission denied" on /var/run/docker.sock). The preview port is published
                // so cloudflared (--network host) reaches it at the host-internal ip; the runner is also on the
                // shared network to resolve sandbox container names. The tools digest label drives recreate-on-change.
                `docker run -d --restart unless-stopped --user root --name ${CONTAINER} --label intentic.id=${ctx.id} --label intentic.tools=${digest} ` +
                    `-p ${parsed.previewPort}:${parsed.previewPort} --network ${parsed.network} ` +
                    `-v /var/run/docker.sock:/var/run/docker.sock ` +
                    `-e ZONE=${parsed.zone} -e PREVIEW_PORT=${parsed.previewPort} -e SANDBOX_IMAGE=${parsed.sandboxImage}${channelEnv}${agentEnv}${toolsEnv} ${parsed.image}`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start workspace runner on host: exited ${run.code}: ${run.stderr.trim()}`);
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
