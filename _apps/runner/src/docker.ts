import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Runs a `docker` subcommand against the host daemon (the runner has the socket bind-mounted, like
// forgejo-runner). Injectable so the lifecycle logic is unit-testable without Docker. Never rejects — a
// non-zero exit is returned as `code` so callers (e.g. inspecting an absent container) handle it inline.
export type DockerRunner = (args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;

const defaultDocker: DockerRunner = async (args) => {
    try {
        const { stdout, stderr } = await exec("docker", [...args]);
        return { stdout, stderr, code: 0 };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
    }
};

export interface ContainerState {
    readonly running: boolean;
    readonly image?: string;
}

export interface RunSpec {
    readonly name: string;
    readonly image: string;
    readonly network?: string;
    readonly env?: Readonly<Record<string, string>>;
    // Each entry is a docker `-v` value, e.g. "intentic-workspace-acme:/work".
    readonly volumes?: readonly string[];
    readonly labels?: Readonly<Record<string, string>>;
}

// Whether the named container is running and on which image (absent container → not running).
export const inspectContainer = async (name: string, docker: DockerRunner = defaultDocker): Promise<ContainerState> => {
    const result = await docker(["inspect", "--format", "{{.State.Running}} {{.Config.Image}}", name]);
    if (result.code !== 0) {
        return { running: false };
    }
    const [running, image] = result.stdout.trim().split(" ");
    return { running: running === "true", ...(image !== undefined && image !== "" ? { image } : {}) };
};

export const runContainer = async (spec: RunSpec, docker: DockerRunner = defaultDocker): Promise<void> => {
    const args = ["run", "-d", "--restart", "unless-stopped", "--name", spec.name];
    if (spec.network !== undefined) {
        args.push("--network", spec.network);
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) {
        args.push("-e", `${key}=${value}`);
    }
    for (const volume of spec.volumes ?? []) {
        args.push("-v", volume);
    }
    for (const [key, value] of Object.entries(spec.labels ?? {})) {
        args.push("--label", `${key}=${value}`);
    }
    args.push(spec.image);
    const result = await docker(args);
    if (result.code !== 0) {
        throw new Error(`docker run ${spec.name} failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
};

// Idempotent: removing an absent container is success.
export const removeContainer = async (name: string, docker: DockerRunner = defaultDocker): Promise<void> => {
    await docker(["rm", "-f", name]);
};

// Create the shared network if it does not exist yet (the runner and every sandbox attach to it).
export const ensureNetwork = async (name: string, docker: DockerRunner = defaultDocker): Promise<void> => {
    if ((await docker(["network", "inspect", name])).code === 0) {
        return;
    }
    const created = await docker(["network", "create", name]);
    if (created.code !== 0) {
        throw new Error(`docker network create ${name} failed (exit ${created.code}): ${created.stderr.trim()}`);
    }
};
