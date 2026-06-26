import type { SecretRef } from "@intentic/graph";
import { makeRef } from "@intentic/graph";
import type { AppIntent } from "@intentic/need-resolver";
import type { ResolvedNode } from "@intentic/resources";
import { deploymentId, deploymentPort, ghCiId, repoId } from "./ids.js";
import type { IngressPair } from "./route.js";
import { exposeRoute } from "./route.js";

// The GitHub app resolver: everything shipping an app through GitHub — a gh-repo, and per environment a
// gh-ci node (commits the GitHub Actions workflow + repo secrets) and a gh-deployment (manages the container
// directly via SSH on the host). No Forgejo, no Komodo — GitHub Actions is the CI, GHCR is the registry,
// and the host is reached directly over SSH from the workflow.
export const resolveAppGitHub = (
    intent: AppIntent,
    githubId: string,
    apiToken: SecretRef,
    zone: string,
    token: SecretRef,
): { nodes: ResolvedNode[]; ingress: IngressPair[] } => {
    const repo = repoId(intent.id);
    const owner = makeRef<string>(githubId, "owner");

    // Telemetry wiring: same as the Forgejo path.
    const otel =
        intent.observe !== undefined
            ? { OTEL_EXPORTER_OTLP_ENDPOINT: makeRef<string>(intent.observe, "otlpEndpoint"), OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }
            : undefined;

    const nodes: ResolvedNode[] = [
        {
            id: repo,
            type: "gh-repo",
            inputs: { name: intent.id, owner, private: true, token },
            explicitDependsOn: [githubId],
        },
    ];
    const ingress: IngressPair[] = [];

    for (const [name, environment] of Object.entries(intent.environments)) {
        const id = deploymentId(intent.id, name);
        const port = deploymentPort(id);
        const env = otel !== undefined || environment.env !== undefined ? { ...otel, ...environment.env } : undefined;
        const ci = ghCiId(intent.id, name);

        // GitHub Actions CI wiring: commits the workflow that builds + pushes to GHCR + SSHes into the host
        // to deploy. Sets HOST_SSH_KEY, HOST_ADDRESS, HOST_USER as repo secrets.
        nodes.push({
            id: ci,
            type: "gh-ci",
            inputs: {
                owner,
                repoName: intent.id,
                branch: environment.branch,
                tag: name,
                token,
                hostAddress: makeRef<string>(intent.on, "publicIp"),
                hostUser: intent.on, // resolved to the host's user via its inputs at apply time
                hostSshKey: intent.on, // the host's SSH key, set as a repo secret
                deploymentId: id,
                port,
                ...(env !== undefined ? { env } : {}),
            },
            explicitDependsOn: [githubId, repo],
        });

        // The container running on the host, managed directly via SSH.
        nodes.push({
            id,
            type: "gh-deployment",
            inputs: {
                owner,
                repoName: intent.id,
                tag: name,
                domain: environment.domain,
                internalIp: makeRef<string>(intent.on, "internalIp"),
                port,
                // The host SSH creds for direct container management.
                address: intent.on,
                ...(env !== undefined ? { env } : {}),
            },
            explicitDependsOn: [ci, ...(intent.observe !== undefined ? [intent.observe] : [])],
            ...(environment.readyWhen !== undefined ? { readyWhen: environment.readyWhen } : {}),
        });

        const exposure = exposeRoute(intent.expose, intent.on, environment.domain, port, apiToken);
        nodes.push(exposure.route);
        ingress.push(exposure.ingress);
    }

    return { nodes, ingress };
};
