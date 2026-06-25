import type { SecretRef } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { AppIntent } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { adminUsername, ciId, deploymentId, deploymentPort, forgejoNotifyId, gitDomain, komodoNotifyId, registryAuthority, repoId } from "./ids.js";
import type { PlatformRefs } from "./platform.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The app resolver: everything shipping an app beyond the shared platform — a repo, and per environment a CI
// node (commits the build-and-deploy workflow + repo secrets), a Komodo deployment pointed at the registry
// image, and its Cloudflare route. intentic does NOT build or deploy: the CI workflow builds + pushes the
// image on a developer push and Komodo rolls it out. The config nodes (repo/ci/deployment/notify) talk to the
// Forgejo or Komodo HTTP API, so each carries the backend `url` ref + the admin password it logs in with.
// Returns each environment's ingress pair so the caller can aggregate the host's tunnel ingress.
export const resolveApp = (
    intent: AppIntent,
    platform: PlatformRefs,
    apiToken: SecretRef,
    zone: string,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const repo = repoId(intent.id);
    const forgejoUrl = makeRef<string>(platform.forgejo, "url");
    const komodoUrl = makeRef<string>(platform.deploy, "url");
    // The CI workflow's notify step runs ON the host (runner is --network host), so it reaches Komodo at its
    // internal url directly — the public url would hairpin through the tunnel and depend on DNS being live.
    const komodoInternalUrl = makeRef<string>(platform.deploy, "internalUrl");
    const packagesToken = makeRef<string>(platform.forgejo, "packagesToken");
    const forgejoAdmin = { adminUser: adminUsername, adminPassword: generated("FORGEJO_ADMIN_PASSWORD") };
    const komodoAdmin = { adminUser: adminUsername, adminPassword: generated("KOMODO_ADMIN_PASSWORD") };
    // Telemetry wiring: when the app observes a service, every deployment exports OTLP to that service's
    // host-internal endpoint. Spread before the author's own env so an explicit OTEL_* can still override.
    const otel =
        intent.observe !== undefined
            ? { OTEL_EXPORTER_OTLP_ENDPOINT: makeRef<string>(intent.observe, "otlpEndpoint"), OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }
            : undefined;

    const nodes: ResolvedNode[] = [
        {
            id: repo,
            type: "repo",
            inputs: { name: intent.id, private: true, forgejoUrl, domain: gitDomain(zone), ...forgejoAdmin },
            // Calls the public git URL, so it must run after git's DNS + tunnel route is live.
            explicitDependsOn: [platform.forgejo, platform.gitRoute],
        },
    ];
    const ingress: IngressPair[] = [];

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        const port = deploymentPort(id);
        const env = otel !== undefined || environment.env !== undefined ? { ...otel, ...environment.env } : undefined;
        const ci = ciId(intent.id, name);
        // CI/CD wiring: commits the Forgejo Actions workflow (build -> push registry image -> notify Komodo) +
        // the registry-push and Komodo-login repo secrets, and seeds a starter Dockerfile if the repo has none.
        nodes.push({
            id: ci,
            type: "ci",
            inputs: {
                forgejoUrl,
                ...forgejoAdmin,
                komodoPassword: komodoAdmin.adminPassword,
                repoName: intent.id,
                branch: environment.branch,
                registry: registryAuthority,
                tag: name,
                packagesToken,
                komodoUrl: komodoInternalUrl,
                deployment: id,
            },
            // Commits via the public git URL (waits on git's route) and bakes Komodo's internal url into the
            // workflow (waits on Komodo being up).
            explicitDependsOn: [platform.forgejo, platform.gitRoute, platform.deploy, repo],
        });
        nodes.push({
            id,
            type: "deployment",
            inputs: {
                repoName: intent.id,
                registry: registryAuthority,
                tag: name,
                domain: environment.domain,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                port,
                komodoUrl,
                ...komodoAdmin,
                ...(env !== undefined ? { env } : {}),
            },
            // Depends on ci so the workflow + secrets exist first; the route gates Komodo reachability. No
            // default readyWhen: apply only registers the deployment (it does not go live until CI pushes an
            // image), so an httpOk gate would hang forever — honour only an author-supplied one.
            explicitDependsOn: [ci, platform.komodoRoute, ...(intent.observe !== undefined ? [intent.observe] : [])],
            ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    // CI/CD notifications: when the author asks for them, derive the two native Discord sinks — a Forgejo
    // repo webhook on build results (CI) and a Komodo alerter scoped to this app's deployments on deploy
    // results (CD). Pure sinks: no outputs. Each carries the backend admin creds it authenticates with.
    if (intent.notify !== undefined) {
        nodes.push({
            id: forgejoNotifyId(intent.id),
            type: "forgejo-notify",
            inputs: { forgejoUrl, ...forgejoAdmin, repoName: intent.id, webhook: intent.notify.discord, events: ["build"] },
            explicitDependsOn: [platform.forgejo, platform.gitRoute, repo],
        });
        const targets = Object.keys(intent.environments).map((environment) => deploymentId(intent.id, environment));
        nodes.push({
            id: komodoNotifyId(intent.id),
            type: "komodo-notify",
            inputs: { komodoUrl, ...komodoAdmin, targets, webhook: intent.notify.discord, events: ["deploy"] },
            explicitDependsOn: [platform.deploy, platform.komodoRoute, ...targets],
        });
    }

    return { nodes, ingress };
};
