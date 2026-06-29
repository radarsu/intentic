import { createHash } from "node:crypto";
import { type DockerRunner, ensureNetwork, inspectContainer, removeContainer, runContainer } from "./docker.js";

export interface SandboxSpec {
    // The project this sandbox belongs to (one sandbox per project). Drives the container/volume names and
    // the preview subdomain.
    readonly project: string;
    // The pinned sandbox image (Phase 1's @intentic/sandbox image).
    readonly image: string;
    // The shared internal docker network the runner and every sandbox attach to.
    readonly network: string;
    // The app's watch command + port, passed through to the sandbox daemon's DevServer.
    readonly devCommand: string;
    readonly devPort: number;
    // The sandbox daemon's port (the runner reaches it by container name on the shared network).
    readonly daemonPort: number;
    // The Cloudflare zone, when the host is on the control plane — used to build the sandbox's PUBLIC agent
    // URL (`https://<project>.preview.<zone>/__agent`) the browser connects to directly. Absent for
    // preview-only hosts.
    readonly zone?: string;
    // Agent credentials (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) the runner passes through — never baked
    // into the image.
    readonly agentEnv: Readonly<Record<string, string>>;
}

export interface Sandbox {
    readonly name: string;
    // Where the runner reaches the sandbox daemon (container DNS on the shared network).
    readonly daemonUrl: string;
    readonly devPort: number;
    // The public base URL the browser hits to reach the daemon directly (via the preview tunnel + the
    // runner proxy's `/__agent` route). Present only when a zone is configured.
    readonly agentUrl?: string;
}

export const sandboxName = (project: string): string => `intentic-sandbox-${project}`;
const workspaceVolume = (project: string): string => `intentic-workspace-${project}`;

// A digest of the spec inputs that shape the sandbox container (image aside, which is compared directly).
// Stamped as the `intentic.config` label so a change to the forwarded agent env (e.g. INTENTIC_AGENT_TOOLS),
// dev command, or zone recreates an already-running sandbox rather than silently reusing the stale one.
export const configDigest = (spec: SandboxSpec): string =>
    createHash("sha256")
        .update(
            JSON.stringify({
                agentEnv: spec.agentEnv,
                devCommand: spec.devCommand,
                devPort: spec.devPort,
                daemonPort: spec.daemonPort,
                zone: spec.zone ?? "",
            }),
        )
        .digest("hex")
        .slice(0, 16);

const sandboxOf = (spec: SandboxSpec): Sandbox => ({
    name: sandboxName(spec.project),
    daemonUrl: `http://${sandboxName(spec.project)}:${spec.daemonPort}`,
    devPort: spec.devPort,
    ...(spec.zone !== undefined && spec.zone !== "" ? { agentUrl: `https://${spec.project}.preview.${spec.zone}/__agent` } : {}),
});

// Bring the project's sandbox up on the desired image, idempotently: an already-running container on the
// same image is reused; otherwise it is (re)created with the workspace volume, shared network, and the env
// the daemon expects (SANDBOX_HOST=0.0.0.0 so the runner can reach it across the network). The workspace
// volume persists the cloned repos across recreations.
export const ensureSandbox = async (spec: SandboxSpec, docker?: DockerRunner): Promise<Sandbox> => {
    await ensureNetwork(spec.network, docker);
    const name = sandboxName(spec.project);
    const digest = configDigest(spec);
    const state = await inspectContainer(name, docker);
    if (state.running && state.image === spec.image && state.config === digest) {
        return sandboxOf(spec);
    }
    await removeContainer(name, docker);
    await runContainer(
        {
            name,
            image: spec.image,
            network: spec.network,
            env: {
                ...spec.agentEnv,
                WORKSPACE_ROOT: "/work",
                SANDBOX_HOST: "0.0.0.0",
                SANDBOX_PORT: String(spec.daemonPort),
                DEV_COMMAND: spec.devCommand,
                DEV_PORT: String(spec.devPort),
            },
            volumes: [`${workspaceVolume(spec.project)}:/work`],
            labels: { "intentic.project": spec.project, "intentic.config": digest },
            // Let the sandbox reach the host it runs on (SSH self-host deploys to host.docker.internal); the
            // runner gets the same mapping from connect.sh. Harmless when self-host isn't used.
            addHosts: ["host.docker.internal:host-gateway"],
        },
        docker,
    );
    return sandboxOf(spec);
};

export const removeSandbox = async (project: string, docker?: DockerRunner): Promise<void> => {
    await removeContainer(sandboxName(project), docker);
};
