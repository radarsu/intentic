import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import type { SshSession } from "./ssh.js";
import { type SshExecutor, sshExecutor } from "./ssh.js";

const komodoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    forgejoUrl: z.string(),
    runnerToken: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    webhookSecret: z.string(),
});
type KomodoInputs = z.infer<typeof komodoSchema>;
const parse = (inputs: ResolvedInputs): KomodoInputs => parseInputs(komodoSchema, inputs, "komodo");

const CORE = "puristic-komodo-core";
const CORE_PORT = 9120;
const STATE_DIR = "/opt/puristic/komodo";
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: KomodoInputs): string => `http://${parsed.internalIp}:${CORE_PORT}`;
const outputsFor = (parsed: KomodoInputs): Record<string, unknown> => ({ url: `https://${parsed.domain}`, internalUrl: internalUrl(parsed) });

const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "name=^${CORE}$" --format '{{.Names}}'`);
    return result.stdout.trim() === CORE;
};

// FerretDB + Core + Periphery, co-located so Periphery trusts Core via the shared keys volume (no
// onboarding key needed for a single host). Written verbatim over SSH; ${...} interpolation is read by
// docker compose from the .env beside it. Image tags are pinned defaults, centralized for easy bumping.
const composeYaml = (): string =>
    [
        "services:",
        "  postgres:",
        "    image: ghcr.io/ferretdb/postgres-documentdb:latest",
        "    restart: unless-stopped",
        "    environment: { POSTGRES_USER: $KOMODO_DATABASE_USERNAME, POSTGRES_PASSWORD: $KOMODO_DATABASE_PASSWORD, POSTGRES_DB: postgres }",
        "    volumes: [ postgres-data:/var/lib/postgresql/data ]",
        "  ferretdb:",
        "    image: ghcr.io/ferretdb/ferretdb:latest",
        "    restart: unless-stopped",
        "    depends_on: [ postgres ]",
        "    environment: { FERRETDB_POSTGRESQL_URL: postgres://$KOMODO_DATABASE_USERNAME:$KOMODO_DATABASE_PASSWORD@postgres:5432/postgres }",
        "    volumes: [ ferretdb-state:/state ]",
        "  core:",
        "    image: ghcr.io/moghtech/komodo-core:$COMPOSE_KOMODO_IMAGE_TAG",
        "    restart: unless-stopped",
        "    depends_on: [ ferretdb ]",
        `    ports: [ "${CORE_PORT}:9120" ]`,
        "    env_file: ./.env",
        "    volumes: [ keys:/config/keys ]",
        `    labels: [ "puristic.id=${CORE}" ]`,
        "  periphery:",
        "    image: ghcr.io/moghtech/komodo-periphery:$COMPOSE_KOMODO_IMAGE_TAG",
        "    restart: unless-stopped",
        "    environment: { PERIPHERY_CORE_ADDRESS: ws://core:9120, PERIPHERY_CONNECT_AS: Local, PERIPHERY_CORE_PUBLIC_KEYS: file:/config/keys/core.pub }",
        "    volumes: [ /var/run/docker.sock:/var/run/docker.sock, /proc:/proc, keys:/config/keys ]",
        "volumes: { postgres-data: {}, ferretdb-state: {}, keys: {} }",
        "",
    ].join("\n");

// Write the compose file (always) and the .env (once — Core/Periphery secrets must survive restarts). The
// webhook secret is the operator's KOMODO_WEBHOOK_SECRET (shared with the deploy-hooks); passkey/jwt/db
// secrets are host-generated once and never surface as outputs.
const ensureFiles = async (session: SshSession, parsed: KomodoInputs): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml()}COMPOSE_EOF`);
    const staticEnv = [
        "TZ=Etc/UTC",
        "COMPOSE_KOMODO_IMAGE_TAG=2",
        "KOMODO_LOCAL_AUTH=true",
        `KOMODO_INIT_ADMIN_USERNAME=${parsed.adminUser}`,
        "KOMODO_DATABASE_ADDRESS=ferretdb:27017",
        "KOMODO_FIRST_SERVER_NAME=Local",
        "KOMODO_FIRST_SERVER=https://periphery:8120",
    ].join("\n");
    const generated = [
        `echo "KOMODO_HOST=https://${parsed.domain}"`,
        `echo "KOMODO_INIT_ADMIN_PASSWORD=${parsed.adminPassword}"`,
        `echo "KOMODO_WEBHOOK_SECRET=${parsed.webhookSecret}"`,
        `echo "KOMODO_PASSKEY=$(openssl rand -hex 32)"`,
        `echo "KOMODO_JWT_SECRET=$(openssl rand -hex 32)"`,
        'echo "KOMODO_DATABASE_USERNAME=komodo"',
        `echo "KOMODO_DATABASE_PASSWORD=$(openssl rand -hex 16)"`,
    ].join("; ");
    await session.exec(
        `test -f ${STATE_DIR}/.env || { printf '%s\\n' '${staticEnv.replace(/\n/g, "\\n")}' > ${STATE_DIR}/.env; { ${generated}; } >> ${STATE_DIR}/.env; }`,
    );
};

const waitHealthy = async (api: KomodoApi, baseUrl: string): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await api.health({ baseUrl })) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`komodo did not become healthy within ${READY_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
};

// Komodo (the deploy orchestrator) as a co-located FerretDB + Core + Periphery compose stack on the host.
// read returns the resource only when Core is up and answering /api/health (so a noop re-derives the
// deterministic url/internalUrl); diff is a noop. apply is idempotent: secrets persist host-side and
// `docker compose up -d` reconciles the stack. No passkey/apiKey output — the CD-notify provider
// authenticates by admin login.
export const createKomodoProvider = (api: KomodoApi = komodoApi, executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`komodo "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session))) {
                return undefined;
            }
        } finally {
            await session.dispose();
        }
        if (!(await api.health({ baseUrl: internalUrl(parsed) }))) {
            return undefined;
        }
        return { outputs: outputsFor(parsed) };
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, parsed);
            const up = await session.exec(`docker compose -p komodo -f ${STATE_DIR}/compose.yaml up -d`);
            if (up.code !== 0) {
                throw new Error(`failed to bring up komodo stack: exited ${up.code}: ${up.stderr.trim()}`);
            }
        } finally {
            await session.dispose();
        }
        await waitHealthy(api, internalUrl(parsed));
        return outputsFor(parsed);
    },
});
