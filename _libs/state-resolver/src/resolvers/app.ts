import type { Ref, SecretRef } from "@intentic/graph";
import { generated, makeRef } from "@intentic/graph";
import type { AppIntent, BackingIntent, HostInput } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { bindingEnv, resolveBinding } from "./backing.js";
import {
    adminUsername,
    ciId,
    deploymentId,
    deploymentPort,
    forgejoNotifyId,
    forgejoOrgId,
    gitDomain,
    komodoNotifyId,
    orgName,
    registryAuthority,
    repoId,
} from "../lib/ids.js";
import type { PlatformRefs } from "./platform.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The app resolver: everything shipping an app beyond the shared platform — a repo, and per environment a CI
// node (commits the build-and-deploy workflow + repo secrets), a Komodo deployment pointed at the registry
// image, and its Cloudflare route. intentic does NOT build or deploy: the CI workflow builds + pushes the
// image on a developer push and Komodo rolls it out. The config nodes (repo/ci/deployment/notify) talk to the
// Forgejo or Komodo HTTP API, so each carries the backend `url` ref + the admin password it logs in with.
// Returns each environment's ingress pair so the caller can aggregate the host's tunnel ingress.
// `controlPlaneHost` is the id of the host running the shared platform (Forgejo/Komodo); identity nodes
// (forgejo-org) are scoped under it, not `intent.on` (which may be a worker host).
export const resolveApp = (
    intent: AppIntent,
    platform: PlatformRefs,
    apiToken: SecretRef,
    zone: string,
    controlPlaneHost: string,
    // The backing instances this app may consume, keyed by instance id, each with the host it runs on (the
    // binding nodes deploy onto that host over SSH). emit builds this from intent.backings + the host map.
    backings: ReadonlyMap<string, { readonly intent: BackingIntent; readonly host: HostInput }>,
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
    // The repo + registry namespace: the first team grant's org owns the app; with no grants it falls back to
    // the single admin owner (identical to the original single-admin behaviour). The admin still authenticates
    // every call (forgejoAdmin) — it owns the org, so its git + packages tokens retain full access.
    // Forgejo org ids are scoped under the control-plane host (one Forgejo for all hosts).
    const ownerTeam = intent.teams?.[0];
    const owner = ownerTeam !== undefined ? orgName(ownerTeam.team) : adminUsername;
    const ownerDeps = ownerTeam !== undefined ? [forgejoOrgId(controlPlaneHost, ownerTeam.team)] : [];
    // Telemetry wiring: when the app observes a service, every deployment exports OTLP to that service's
    // host-internal endpoint. Spread before the author's own env so an explicit OTEL_* can still override.
    const otel =
        intent.observe !== undefined
            ? { OTEL_EXPORTER_OTLP_ENDPOINT: makeRef<string>(intent.observe, "otlpEndpoint"), OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }
            : undefined;

    // Backing wiring: for each capability the app uses, emit a per-app binding node that mints the app's
    // isolated credentials on the instance, inject its connection env vars (DATABASE_URL, VALKEY_URL, …) into
    // every deployment, and gate each deployment on the binding so the credentials exist before it registers.
    // The app's public domains across environments — the auth binding whitelists OIDC redirects under them.
    const appDomains = Object.values(intent.environments).map((environment) => environment.domain);
    const bindingNodes: ResolvedNode[] = [];
    const bound: Record<string, Ref<string>> = {};
    const bindingDeps: string[] = [];
    for (const binding of intent.use ?? []) {
        const backing = backings.get(binding.target);
        if (backing === undefined) {
            throw new Error(`app "${intent.id}" uses unknown backing "${binding.target}"; declare it with i.want.${binding.capability}`);
        }
        const node = resolveBinding(intent.id, backing.intent, backing.host, appDomains);
        bindingNodes.push(node);
        Object.assign(bound, bindingEnv(intent.id, backing.intent));
        bindingDeps.push(node.id);
    }

    const nodes: ResolvedNode[] = [
        ...bindingNodes,
        {
            id: repo,
            type: "repo",
            inputs: { name: intent.id, owner, private: true, forgejoUrl, domain: gitDomain(zone), ...forgejoAdmin },
            // Calls the public git URL, so it must run after git's DNS + tunnel route is live; and after the
            // owning org exists when the app is team-owned.
            explicitDependsOn: [platform.forgejo, platform.gitRoute, ...ownerDeps],
        },
    ];
    const ingress: IngressPair[] = [];

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        const port = deploymentPort(id);
        // OTLP + backing connection vars first, the author's own env last so an explicit value still wins.
        const merged = { ...otel, ...bound, ...environment.env };
        const env = Object.keys(merged).length > 0 ? merged : undefined;
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
                owner,
                repoName: intent.id,
                branch: environment.branch,
                registry: registryAuthority(zone),
                tag: name,
                packagesToken,
                komodoUrl: komodoInternalUrl,
                deployment: id,
            },
            // Commits via the public git URL (waits on git's route) and bakes Komodo's internal url into the
            // workflow (waits on Komodo being up); the repo it commits into is owned by the org (waits on it).
            explicitDependsOn: [platform.forgejo, platform.gitRoute, platform.deploy, repo, ...ownerDeps],
        });
        nodes.push({
            id,
            type: "deployment",
            inputs: {
                // The Komodo Server to target: worker hosts use the host id (registered by komodo-server);
                // the CP host omits this so the schema default "Local" is used (auto-created by Komodo's
                // KOMODO_FIRST_SERVER_NAME).
                ...(intent.on !== controlPlaneHost ? { server: intent.on } : {}),
                owner,
                repoName: intent.id,
                registry: registryAuthority(zone),
                tag: name,
                domain: environment.domain,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                port,
                komodoUrl,
                ...komodoAdmin,
                ...(env !== undefined ? { env } : {}),
            },
            // Depends on ci so the workflow + secrets exist first; the route gates Komodo reachability; and on
            // each backing binding so the app's credentials exist before it registers. No default readyWhen:
            // apply only registers the deployment (it does not go live until CI pushes an image), so an httpOk
            // gate would hang forever — honour only an author-supplied one.
            explicitDependsOn: [ci, platform.deployRoute, ...(intent.observe !== undefined ? [intent.observe] : []), ...bindingDeps],
            ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
        });
        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    // CI/CD notifications: when the app wires a Discord handle (notify: discord), derive the two native
    // sinks — a Forgejo repo webhook on build results (CI) and a Komodo alerter scoped to this app's
    // deployments on deploy results (CD). The webhook URL comes from the discord provider's per-app output.
    if (intent.notify !== undefined) {
        const webhook = makeRef<string>(intent.notify, `appWebhook:${intent.id}`);
        nodes.push({
            id: forgejoNotifyId(intent.id),
            type: "forgejo-notify",
            inputs: { forgejoUrl, ...forgejoAdmin, owner, repoName: intent.id, webhook, events: ["build"] },
            explicitDependsOn: [platform.forgejo, platform.gitRoute, repo, intent.notify, ...ownerDeps],
        });
        const targets = Object.keys(intent.environments).map((environment) => deploymentId(intent.id, environment));
        nodes.push({
            id: komodoNotifyId(intent.id),
            type: "komodo-notify",
            inputs: { komodoUrl, ...komodoAdmin, targets, webhook, events: ["deploy"] },
            explicitDependsOn: [platform.deploy, platform.deployRoute, intent.notify, ...targets],
        });
    }

    return { nodes, ingress };
};
