import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "./inputs.js";
import type { SshSession } from "./ssh.js";
import { type SshExecutor, sshExecutor } from "./ssh.js";

const signozSchema = sshSchema.extend({
    internalIp: z.string(),
    domain: z.string(),
    // The dashboard admin SignOz authenticates by email; intentic generates the password and reports it.
    adminUser: z.string(),
    adminPassword: z.string(),
    // The fully-pinned images for the four compose services, inlined into the compose YAML literal so a bump
    // recreates the changed service on the next apply; read observes each running image and diff drives it.
    clickhouseImage: z.string(),
    signozImage: z.string(),
    otelImage: z.string(),
    schemaMigratorImage: z.string(),
});
type SignozInputs = z.infer<typeof signozSchema>;
const parse = (inputs: ResolvedInputs): SignozInputs => parseInputs(signozSchema, inputs, "signoz");

const APP = "intentic-signoz";
const UI_PORT = 8080;
// OTLP ingest published on the host: gRPC 4317 + HTTP 4318. Apps reach the HTTP port through the service's
// `otlpEndpoint` output (http://<internalIp>:4318); it is host-internal, never tunnel-routed.
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const STATE_DIR = "/opt/intentic/signoz";
const READY_TIMEOUT_MS = 180_000;
const READY_INTERVAL_MS = 4_000;

const internalUrl = (parsed: SignozInputs): string => `http://${parsed.internalIp}:${UI_PORT}`;
const otlpEndpoint = (parsed: SignozInputs): string => `http://${parsed.internalIp}:${OTLP_HTTP_PORT}`;
const outputsFor = (parsed: SignozInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: internalUrl(parsed),
    otlpEndpoint: otlpEndpoint(parsed),
});

// The signoz UI container, matched by the intentic.id label compose stamps on it (not the generated
// "<project>-signoz-1" name).
const running = async (session: SshSession): Promise<boolean> => {
    const result = await session.exec(`docker ps --filter "label=intentic.id=${APP}" --format '{{.Names}}'`);
    return result.stdout.trim() !== "";
};

// The create-time image of each long-running compose service, keyed by compose service name. The one-shot
// schema-migrator-sync exits after running so it never shows here; its version tracks the otel collector's
// (same release line), so diffing the collector covers it. Returns {} when the stack is down.
const PROJECT = "signoz";
const runningImages = async (session: SshSession): Promise<Record<string, string>> => {
    const result = await session.exec(
        `ids=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}"); ` +
            `[ -n "$ids" ] && docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}={{.Config.Image}}' $ids || true`,
    );
    const images: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
            images[line.slice(0, eq)] = line.slice(eq + 1);
        }
    }
    return images;
};

const desiredImages = (parsed: SignozInputs): Record<string, string> => ({
    clickhouse: parsed.clickhouseImage,
    signoz: parsed.signozImage,
    "otel-collector": parsed.otelImage,
});

// ClickHouse (single-node cluster "cluster" SigNoz's migrations expect, backed by ClickHouse Keeper) +
// schema migrators + the SigNoz query/UI server + the OTLP collector. Written verbatim over SSH. Image refs
// are the fully-pinned inputs inlined into the YAML (no .env interpolation — SigNoz holds no secrets), so a
// bump recreates the service on the next `up -d`.
const composeYaml = (parsed: SignozInputs): string =>
    [
        "services:",
        "  clickhouse:",
        `    image: ${parsed.clickhouseImage}`,
        "    restart: unless-stopped",
        "    volumes:",
        "      - clickhouse-data:/var/lib/clickhouse",
        "      - ./clickhouse-cluster.xml:/etc/clickhouse-server/config.d/cluster.xml:ro",
        "    healthcheck:",
        "      test: [ CMD, wget, --spider, -q, localhost:8123/ping ]",
        "      interval: 10s",
        "      timeout: 5s",
        "      retries: 10",
        "  schema-migrator-sync:",
        `    image: ${parsed.schemaMigratorImage}`,
        "    command: [ sync, --dsn=tcp://clickhouse:9000, --up= ]",
        "    depends_on: { clickhouse: { condition: service_healthy } }",
        "    restart: on-failure",
        "  signoz:",
        `    image: ${parsed.signozImage}`,
        "    restart: unless-stopped",
        "    depends_on: [ schema-migrator-sync ]",
        `    ports: [ "${UI_PORT}:8080" ]`,
        "    environment:",
        "      - TZ=Etc/UTC",
        "      - SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN=tcp://clickhouse:9000",
        "    volumes: [ signoz-data:/var/lib/signoz ]",
        `    labels: [ "intentic.id=${APP}" ]`,
        "  otel-collector:",
        `    image: ${parsed.otelImage}`,
        "    restart: unless-stopped",
        "    depends_on: [ signoz ]",
        "    command: [ --config=/etc/otel-collector-config.yaml ]",
        "    volumes: [ ./otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro ]",
        `    ports: [ "${OTLP_GRPC_PORT}:4317", "${OTLP_HTTP_PORT}:4318" ]`,
        "volumes: { clickhouse-data: {}, signoz-data: {} }",
        "",
    ].join("\n");

// A single-shard, single-replica cluster named "cluster" with embedded ClickHouse Keeper — what SigNoz's
// schema migrator targets, without standing up a separate ZooKeeper for one host.
const clickhouseClusterXml = (): string =>
    [
        "<clickhouse>",
        "  <zookeeper><node><host>clickhouse</host><port>9181</port></node></zookeeper>",
        "  <keeper_server>",
        "    <tcp_port>9181</tcp_port>",
        "    <server_id>1</server_id>",
        "    <raft_configuration><server><id>1</id><hostname>clickhouse</hostname><port>9234</port></server></raft_configuration>",
        "  </keeper_server>",
        "  <remote_servers><cluster><shard><replica><host>clickhouse</host><port>9000</port></replica></shard></cluster></remote_servers>",
        "  <macros><shard>01</shard><replica>01</replica></macros>",
        "</clickhouse>",
        "",
    ].join("\n");

// OTLP in (gRPC + HTTP), batched out to ClickHouse — the traces/metrics/logs pipelines apps export to.
const otelCollectorConfig = (): string =>
    [
        "receivers:",
        "  otlp:",
        "    protocols:",
        "      grpc: { endpoint: 0.0.0.0:4317 }",
        "      http: { endpoint: 0.0.0.0:4318 }",
        "processors:",
        "  batch: {}",
        "exporters:",
        "  clickhousetraces: { datasource: tcp://clickhouse:9000/signoz_traces }",
        "  clickhousemetricswrite: { endpoint: tcp://clickhouse:9000/signoz_metrics }",
        "  clickhouselogsexporter: { dsn: tcp://clickhouse:9000/signoz_logs }",
        "service:",
        "  pipelines:",
        "    traces: { receivers: [ otlp ], processors: [ batch ], exporters: [ clickhousetraces ] }",
        "    metrics: { receivers: [ otlp ], processors: [ batch ], exporters: [ clickhousemetricswrite ] }",
        "    logs: { receivers: [ otlp ], processors: [ batch ], exporters: [ clickhouselogsexporter ] }",
        "",
    ].join("\n");

// Write the compose + config files (always). No .env: SigNoz holds no secrets and the image refs are inlined
// in the compose YAML, so there is nothing to interpolate. The dashboard admin is seeded post-health below.
const ensureFiles = async (session: SshSession, parsed: SignozInputs): Promise<void> => {
    await session.exec(`mkdir -p ${STATE_DIR}`);
    await session.exec(`cat > ${STATE_DIR}/compose.yaml <<'COMPOSE_EOF'\n${composeYaml(parsed)}COMPOSE_EOF`);
    await session.exec(`cat > ${STATE_DIR}/clickhouse-cluster.xml <<'CH_EOF'\n${clickhouseClusterXml()}CH_EOF`);
    await session.exec(`cat > ${STATE_DIR}/otel-collector-config.yaml <<'OTEL_EOF'\n${otelCollectorConfig()}OTEL_EOF`);
};

// Probe the UI FROM THE HOST over SSH (SigNoz publishes 8080 on the host), so the check works regardless of
// whether the engine's own network can reach the host's internal ip. It answers 200 on / once up.
const healthy = async (session: SshSession, parsed: SignozInputs): Promise<boolean> => {
    const result = await session.exec(`wget -q -O /dev/null ${internalUrl(parsed)}`);
    return result.code === 0;
};

const waitHealthy = async (session: SshSession, parsed: SignozInputs): Promise<void> => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
        if (await healthy(session, parsed)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`signoz did not become healthy within ${READY_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
    }
};

// Seed the dashboard's first admin via SigNoz's register API, FROM THE HOST over SSH. Best-effort and
// idempotent: once a user exists SigNoz rejects re-registration, which we log and ignore rather than fail —
// the account already matches the credentials access.md advertises.
const seedAdmin = async (session: SshSession, parsed: SignozInputs, log: (message: string) => void): Promise<void> => {
    const body = JSON.stringify({ name: "intentic", orgName: "intentic", email: parsed.adminUser, password: parsed.adminPassword });
    const result = await session.exec(
        `curl -s -o /dev/null -w '%{http_code}' -X POST ${internalUrl(parsed)}/api/v1/register -H 'Content-Type: application/json' -d '${body}'`,
    );
    if (result.stdout.trim() !== "200") {
        log(`signoz: register returned ${result.stdout.trim() || "no status"} (admin likely already seeded)`);
    }
};

// SigNoz (observability) as a co-located ClickHouse + schema-migrator + query/UI + OTLP-collector compose
// stack on the host. read returns the resource only when the UI is up (so a noop re-derives the
// deterministic url/internalUrl/otlpEndpoint); diff is a noop. apply is idempotent: image tags persist
// host-side, `docker compose up -d` reconciles the stack, and the admin seed tolerates an existing account.
export const createSignozProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(sshTarget(parsed));
        } catch (error) {
            ctx.log(`signoz "${ctx.id}": host not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            if (!(await running(session)) || !(await healthy(session, parsed))) {
                return undefined;
            }
            return { outputs: outputsFor(parsed), detail: { images: await runningImages(session) } };
        } finally {
            await session.dispose();
        }
    },
    // `up -d` recreates only the services whose pinned image in compose.yaml changed; the named volumes
    // (clickhouse-data/signoz-data) survive, so a bump is a safe in-place update gated on health.
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const images = (observed.detail?.["images"] ?? {}) as Record<string, string>;
        for (const [service, desired] of Object.entries(desiredImages(parsed))) {
            if (images[service] !== desired) {
                return { action: "update", reason: `signoz ${service} image differs (running ${String(images[service])}, want ${desired})` };
            }
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await ensureFiles(session, parsed);
            const up = await session.exec(`docker compose -p signoz --project-directory ${STATE_DIR} -f ${STATE_DIR}/compose.yaml up -d`);
            if (up.code !== 0) {
                throw new Error(`failed to bring up signoz stack: exited ${up.code}: ${up.stderr.trim()}`);
            }
            await waitHealthy(session, parsed);
            await seedAdmin(session, parsed, ctx.log);
            return outputsFor(parsed);
        } finally {
            await session.dispose();
        }
    },
    delete: async (inputs) => {
        const parsed = parse(inputs);
        const session = await executor.connect(sshTarget(parsed));
        try {
            await session.exec(`docker compose -p signoz --project-directory ${STATE_DIR} -f ${STATE_DIR}/compose.yaml down -v 2>/dev/null || true`);
            await session.exec(`rm -rf ${STATE_DIR}`);
        } finally {
            await session.dispose();
        }
    },
});
