import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { gitProvider, parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshSession } from "./ssh.js";
import { type SshExecutor, sshExecutor } from "./ssh.js";

const komodoSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    forgejoUrl: z.string(),
    runnerToken: z.string(),
    adminUser: z.string(),
    adminPassword: z.string(),
    // The host git provider Komodo authenticates to when cloning the admin's private app repos.
    // forgejoUrl is the INTERNAL Forgejo url (http://<internalIp>:3000); Komodo clones the repos from inside
    // the host's Docker, so the git-provider account is registered against this internal authority (the public
    // git.<zone> name does not resolve there). gitAccount/gitToken are the admin + its scoped read token.
    gitAccount: z.string(),
    gitToken: z.string(),
    // The Forgejo built-in container registry (e.g. "localhost:3000") Komodo PULLS app images from, with the
    // admin's packages token — written as a [[docker_registry]] account so a private image can be pulled.
    registry: z.string(),
    packagesToken: z.string(),
});
type KomodoInputs = z.infer<typeof komodoSchema>;
const parse = (inputs: ResolvedInputs): KomodoInputs => parseInputs(komodoSchema, inputs, "komodo");

const CORE = "intentic-komodo-core";
const CORE_PORT = 9120;
const STATE_DIR = "/opt/intentic/komodo";
const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 3_000;

const internalUrl = (parsed: KomodoInputs): string => `http://${parsed.internalIp}:${CORE_PORT}`;
const outputsFor = (parsed: KomodoInputs): Record<string, unknown> => ({ url: `https://${parsed.domain}`, internalUrl: internalUrl(parsed) });

// docker compose names the core container "<project>-core-1", not CORE, so match it by the intentic.id
// label the compose stamps on it instead of by an exact container name.
const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "label=intentic.id=${CORE}" --format '{{.Names}}'`);
    return result.stdout.trim() !== "";
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
        // config.toml carries the git-provider account (Komodo clones private app repos with it); bind it in
        // read-only. Relative to --project-directory (STATE_DIR), so it resolves to the file ensureFiles writes.
        "    volumes: [ keys:/config/keys, ./config.toml:/config/config.toml:ro ]",
        `    labels: [ "intentic.id=${CORE}" ]`,
        // INBOUND-mode agent: with no core_address set, periphery keeps its default 8120 listener (SSL on,
        // self-signed cert auto-generated) that Core dials at https://periphery:8120. Setting
        // PERIPHERY_CORE_ADDRESS would flip it to outbound mode and DISABLE that listener (Core's dial would
        // be refused). Co-located on this private compose network, the shared keys volume persists each side's
        // Noise keypair and the handshake needs no pre-shared passkey or pinned core key.
        "  periphery:",
        "    image: ghcr.io/moghtech/komodo-periphery:$COMPOSE_KOMODO_IMAGE_TAG",
        "    restart: unless-stopped",
        "    volumes: [ /var/run/docker.sock:/var/run/docker.sock, /proc:/proc, keys:/config/keys ]",
        "volumes: { postgres-data: {}, ferretdb-state: {}, keys: {} }",
        "",
    ].join("\n");

// The provider accounts Komodo uses against the host's Forgejo: a git_provider (to clone private app repos)
// and a docker_registry (to pull the private app images CI pushes). Neither can be configured via env in
// Komodo v2 — only via this config file (or the UI/API) — so both are mounted into Core. The docker_registry
// domain is the registry authority the deployment's image_registry_account selects.
const configToml = (parsed: KomodoInputs): string => {
    const git = gitProvider(parsed.forgejoUrl);
    return [
        "[[git_provider]]",
        `domain = "${git.domain}"`,
        `https = ${git.https}`,
        `accounts = [{ username = "${parsed.gitAccount}", token = "${parsed.gitToken}" }]`,
        "",
        "[[docker_registry]]",
        `domain = "${parsed.registry}"`,
        `accounts = [{ username = "${parsed.adminUser}", token = "${parsed.packagesToken}" }]`,
        "",
    ].join("\n");
};

// Write the compose file + provider config.toml (always) and the .env (once — Core/Periphery secrets must
// survive restarts). passkey/jwt/db secrets are host-generated once and never surface as outputs.
const ensureFiles = async (session: SshSession, parsed: KomodoInputs): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml()}COMPOSE_EOF`);
    await session.exec(`cat > ${STATE_DIR}/config.toml <<'CONFIG_EOF'\n${configToml(parsed)}CONFIG_EOF`);
    // Each line is a separate printf argument so `printf '%s\n'` emits one KEY=value per line. Joining with
    // "\n" into a single arg would print the literal characters \n (printf %s does not interpret escapes),
    // leaving compose unable to parse the file — the image tags would come through blank.
    const staticEnv = [
        "TZ=Etc/UTC",
        "COMPOSE_KOMODO_IMAGE_TAG=2",
        "KOMODO_LOCAL_AUTH=true",
        "KOMODO_CONFIG_PATH=/config/config.toml",
        `KOMODO_INIT_ADMIN_USERNAME=${parsed.adminUser}`,
        "KOMODO_DATABASE_ADDRESS=ferretdb:27017",
        "KOMODO_FIRST_SERVER_NAME=Local",
        "KOMODO_FIRST_SERVER_ADDRESS=https://periphery:8120",
        // How often Komodo polls a deployment's registry tag for a new digest; with auto_update set, a CI push
        // goes live within this window even if the workflow's notify step is unavailable.
        "KOMODO_RESOURCE_POLL_INTERVAL=1-min",
    ]
        .map((line) => `'${line}'`)
        .join(" ");
    const generated = [
        `echo "KOMODO_HOST=https://${parsed.domain}"`,
        `echo "KOMODO_INIT_ADMIN_PASSWORD=${parsed.adminPassword}"`,
        `echo "KOMODO_PASSKEY=$(openssl rand -hex 32)"`,
        `echo "KOMODO_JWT_SECRET=$(openssl rand -hex 32)"`,
        'echo "KOMODO_DATABASE_USERNAME=komodo"',
        `echo "KOMODO_DATABASE_PASSWORD=$(openssl rand -hex 16)"`,
    ].join("; ");
    await session.exec(`test -f ${STATE_DIR}/.env || { printf '%s\\n' ${staticEnv} > ${STATE_DIR}/.env; { ${generated}; } >> ${STATE_DIR}/.env; }`);
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
