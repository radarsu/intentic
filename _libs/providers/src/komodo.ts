import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
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
    // Each line is a separate printf argument so `printf '%s\n'` emits one KEY=value per line. Joining with
    // "\n" into a single arg would print the literal characters \n (printf %s does not interpret escapes),
    // leaving compose unable to parse the file — the image tags would come through blank.
    const staticEnv = [
        "TZ=Etc/UTC",
        "COMPOSE_KOMODO_IMAGE_TAG=2",
        "KOMODO_LOCAL_AUTH=true",
        `KOMODO_INIT_ADMIN_USERNAME=${parsed.adminUser}`,
        "KOMODO_DATABASE_ADDRESS=ferretdb:27017",
        "KOMODO_FIRST_SERVER_NAME=Local",
        "KOMODO_FIRST_SERVER=https://periphery:8120",
    ]
        .map((line) => `'${line}'`)
        .join(" ");
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
        `test -f ${STATE_DIR}/.env || { printf '%s\\n' ${staticEnv} > ${STATE_DIR}/.env; { ${generated}; } >> ${STATE_DIR}/.env; }`,
    );
};

// Probe Core FROM THE HOST over SSH (Core publishes 9120 on the host), so the check works regardless of
// whether the engine's own network can reach the host's internal ip. Core has no dedicated health route;
// it answers 200 on / once it is up and connected to the database, which is exactly the liveness we want.
const healthy = async (session: SshSession, parsed: KomodoInputs): Promise<boolean> => {
    const result = await session.exec(`wget -q -O /dev/null ${internalUrl(parsed)}`);
    return result.code === 0;
};

const waitHealthy = async (session: SshSession, parsed: KomodoInputs): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await healthy(session, parsed)) {
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
export const createKomodoProvider = (executor: SshExecutor = sshExecutor): Provider => ({
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
            if (!(await running(session)) || !(await healthy(session, parsed))) {
                return undefined;
            }
            return { outputs: outputsFor(parsed) };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, parsed);
            // --env-file/--project-directory pin the .env we wrote as both the interpolation source (the
            // $COMPOSE_KOMODO_IMAGE_TAG etc. in compose.yaml) and the core service's runtime env; without
            // them compose looks in the SSH working dir, leaving the image tags blank.
            const up = await session.exec(
                `docker compose -p komodo --project-directory ${STATE_DIR} --env-file ${STATE_DIR}/.env -f ${STATE_DIR}/compose.yaml up -d`,
            );
            if (up.code !== 0) {
                throw new Error(`failed to bring up komodo stack: exited ${up.code}: ${up.stderr.trim()}`);
            }
            await waitHealthy(session, parsed);
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
});
