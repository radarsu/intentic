import type { SecretRef } from "@intentic/graph";
import { generated, httpOk, makeRef } from "@intentic/graph";
import type { HostInput, ServiceIntent, ServiceKind } from "@intentic/need-resolver";
import type { ResolvedNode, ResourceType } from "@intentic/resources";
import { IMAGES } from "../lib/images.js";
import { sshOf } from "../lib/ssh.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The service catalog: each authorable `kind` maps to the concrete resource type its provider deploys and
// the dashboard port that provider publishes on the host (tunnel-routed to <domain>). Adding Outline /
// Nextcloud / mail later is one entry here plus a provider — the authoring surface (i.want.service) is
// unchanged. The OTLP ingest port a service exposes for app telemetry is the signoz provider's concern, not
// the resolver's — apps reach it through the service's `otlpEndpoint` output, not a routed hostname.
interface ServiceSpec {
    readonly type: ResourceType;
    readonly port: number;
    // The pinned images this service's provider deploys, by input key. Carried here so adding a service is
    // one catalog entry (type + port + its images), and so the versions land in the desired-state graph.
    readonly images: Readonly<Record<string, string>>;
    // How this kind is reached as an MCP tool from the sandbox agent, when a workspace exposes it via
    // `i.want.workspace({ tools: [...] })`: the path on the service's routed domain that speaks MCP, and the
    // intentic-generated secret key holding the scoped bearer token. Absent ⇒ the kind has no agent tool.
    readonly mcp?: { readonly path: string; readonly tokenSecret: string };
}

const catalog: Readonly<Record<ServiceKind, ServiceSpec>> = {
    signoz: {
        type: "signoz",
        port: 8080,
        images: {
            clickhouseImage: IMAGES.clickhouse,
            signozImage: IMAGES.signoz,
            otelImage: IMAGES.signozOtelCollector,
            zookeeperImage: IMAGES.signozZookeeper,
        },
        mcp: { path: "/mcp", tokenSecret: "SIGNOZ_MCP_TOKEN" },
    },
};

// The MCP endpoint descriptor for a service kind, or undefined when the kind exposes no agent tool. The
// workspace resolver uses it to wire a tool's URL + scoped token into the sandbox (for the agent).
export const serviceMcp = (kind: ServiceKind): { readonly path: string; readonly tokenSecret: string } | undefined => catalog[kind].mcp;

// The admin identity intentic seeds for a service's dashboard. Services authenticate by email (unlike the
// Forgejo/Komodo username), so it is an address in the exposed zone; the password is intentic-generated.
const serviceAdminEmail = (zone: string): string => `intentic@${zone}`;

// A shared off-the-shelf service: one node deployed onto the host over SSH (like the platform's Forgejo /
// Komodo) from a pinned image, plus its Cloudflare route. The deploy node carries the host SSH creds + its
// internal ip and gates on its host-internal url so readiness passes before the tunnel + DNS route exist.
// Returns the exposure's ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolveService = (
    intent: ServiceIntent,
    host: HostInput,
    zone: string,
    apiToken: SecretRef,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const spec = catalog[intent.kind];
    const ssh = sshOf(host);
    const exposure = exposeRoute(intent.expose, intent.on, intent.domain, spec.port, apiToken);
    const nodes: ResolvedNode[] = [
        {
            id: intent.id,
            type: spec.type,
            inputs: {
                server: makeRef(intent.on),
                ...ssh,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                domain: intent.domain,
                adminUser: serviceAdminEmail(zone),
                adminPassword: generated("SIGNOZ_ADMIN_PASSWORD"),
                ...spec.images,
            },
            explicitDependsOn: [],
            readyWhen: httpOk(makeRef<string>(intent.id, "internalUrl"), { timeout: "180s" }),
        },
        exposure.route,
    ];
    return { nodes, ingress: [exposure.ingress] };
};
