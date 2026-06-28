import type { SshSession } from "./ssh.js";

// Shared host-side helpers for the backing providers (postgres/valkey instances + their binding nodes). Each
// backing instance is a single container, deployed as a per-instance compose project so multiple instances
// (and multiple backing kinds) co-exist on one host without colliding. The container is stamped with its
// node id as the intentic.id label, so its binding nodes can find it by id with `docker exec`.

// A docker-compose-safe project / path fragment derived from a node id (lowercase, non-alnum -> "-").
const slug = (id: string): string =>
    id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

// The per-instance host directory holding its compose.yaml + .env, and the compose project name.
export const stateDir = (kind: string, id: string): string => `/opt/intentic/${kind}/${slug(id)}`;
const projectName = (kind: string, id: string): string => `intentic-${kind}-${slug(id)}`;

// The id of the container stamped intentic.id=<stamp>, or "" when it is not running. Both an instance (its own
// id) and a binding (the instance id it targets) locate the container this way.
export const containerId = async (session: SshSession, stamp: string): Promise<string> => {
    const result = await session.exec(`docker ps -q --filter "label=intentic.id=${stamp}" --format '{{.ID}}'`);
    return result.stdout.trim().split("\n")[0] ?? "";
};

// The create-time image of the stamped container (.Config.Image is the exact repo:tag@sha256 ref written into
// compose.yaml, so a pin bump reads as drift), or "" when it is not running.
export const containerImage = async (session: SshSession, stamp: string): Promise<string> => {
    const id = await containerId(session, stamp);
    if (id === "") {
        return "";
    }
    const result = await session.exec(`docker inspect --format '{{.Config.Image}}' ${id}`);
    return result.stdout.trim();
};

// `docker compose up -d` for a single-instance project, throwing with stderr on failure.
export const composeUp = async (session: SshSession, kind: string, id: string): Promise<void> => {
    const dir = stateDir(kind, id);
    const up = await session.exec(
        `docker compose -p ${projectName(kind, id)} --project-directory ${dir} --env-file ${dir}/.env -f ${dir}/compose.yaml up -d`,
    );
    if (up.code !== 0) {
        throw new Error(`failed to bring up ${kind} "${id}": exited ${up.code}: ${up.stderr.trim()}`);
    }
};

// `docker compose down -v` + remove the host-side dir; tolerant of an already-gone stack.
export const composeDown = async (session: SshSession, kind: string, id: string): Promise<void> => {
    const dir = stateDir(kind, id);
    await session.exec(
        `docker compose -p ${projectName(kind, id)} --project-directory ${dir} --env-file ${dir}/.env -f ${dir}/compose.yaml down -v 2>/dev/null || true`,
    );
    await session.exec(`rm -rf ${dir}`);
};

// Poll `probe` (a host-side command returning code 0 when ready) until it passes or the deadline elapses.
export const waitReady = async (session: SshSession, kind: string, id: string, probe: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = await session.exec(probe);
        if (result.code === 0) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`${kind} "${id}" did not become ready within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
};
