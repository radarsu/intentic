import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshExecutor, SshSession } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

const forgejoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
});
type ForgejoInputs = z.infer<typeof forgejoSchema>;
const parse = (inputs: ResolvedInputs): ForgejoInputs => parseInputs(forgejoSchema, inputs, "forgejo");

const CONTAINER = "puristic-forgejo";
const IMAGE = "codeberg.org/forgejo/forgejo:15";
const HTTP_PORT = 3000;
// The runner registration token is minted once and persisted on the host, then read back every run, so it
// is a STABLE output (generate-runner-token may rotate, which would otherwise break the stateless contract
// and re-register the runner each apply).
const STATE_DIR = "/opt/puristic/forgejo";
const TOKEN_FILE = `${STATE_DIR}/runner-token`;
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: ForgejoInputs): string => `http://${parsed.internalIp}:${HTTP_PORT}`;
const outputsFor = (parsed: ForgejoInputs, runnerToken: string): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: internalUrl(parsed),
    runnerToken,
});

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CONTAINER}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CONTAINER;
};

const healthy = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker exec ${CONTAINER} wget -q --spider http://localhost:${HTTP_PORT}/api/healthz`);
    return result.code === 0;
};

const persistedToken = async (session: SshSession): Promise<string> => {
    const result = await session.exec(`cat ${TOKEN_FILE} 2>/dev/null || true`);
    return result.stdout.trim();
};

const waitHealthy = async (session: SshSession): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await healthy(session)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`forgejo did not become healthy within ${READY_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
};

// Forgejo (Git + CI) running on the host as a single SQLite-backed container, with an admin user and a
// persisted runner-registration token. read returns the resource only when the container is up, healthy,
// and the token is persisted (so a noop re-derives a stable output set); diff is a noop because the only
// reconciled state is "running + healthy", which read already gates. apply is idempotent: the SQLite data
// lives in a named volume that survives container recreation, and the admin/token bootstraps are guarded.
export const createForgejoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`forgejo "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session)) || !(await healthy(session))) {
                return undefined;
            }
            const token = await persistedToken(session);
            if (token === "") {
                return undefined;
            }
            return { outputs: outputsFor(parsed, token) };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`mkdir -p ${STATE_DIR}`);
            await session.exec(`docker rm -f ${CONTAINER} 2>/dev/null || true`);
            const run = await session.exec(
                `docker run -d --restart unless-stopped --network host --name ${CONTAINER} --label puristic.id=${ctx.id} ` +
                    `-v ${CONTAINER}-data:/data ` +
                    `-e FORGEJO__security__INSTALL_LOCK=true -e FORGEJO__database__DB_TYPE=sqlite3 ` +
                    `-e FORGEJO__server__ROOT_URL=https://${parsed.domain} -e FORGEJO__server__DOMAIN=${parsed.domain} ${IMAGE}`,
            );
            if (run.code !== 0) {
                throw new Error(`failed to start forgejo on host: exited ${run.code}: ${run.stderr.trim()}`);
            }
            await waitHealthy(session);
            // Idempotent admin bootstrap: tolerate the user already existing, propagate anything else.
            const admin = await session.exec(
                `docker exec -u git ${CONTAINER} forgejo admin user create --admin --username ${parsed.adminUser} ` +
                    `--password ${parsed.adminPassword} --email ${parsed.adminUser}@${parsed.domain}`,
            );
            if (admin.code !== 0 && !admin.stderr.includes("already exists")) {
                throw new Error(`failed to create forgejo admin: exited ${admin.code}: ${admin.stderr.trim()}`);
            }
            // Mint the runner token only once; reuse the persisted one on later applies so the output is stable.
            await session.exec(`test -f ${TOKEN_FILE} || docker exec -u git ${CONTAINER} forgejo actions generate-runner-token > ${TOKEN_FILE}`);
            const token = await persistedToken(session);
            if (token === "") {
                throw new Error("forgejo runner token was not persisted");
            }
            return outputsFor(parsed, token);
        } finally {
            await session.dispose();
        }
    },
});
