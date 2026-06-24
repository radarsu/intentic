import type { DesiredStateGraph, SecretRef } from "@puristic/deploy-protocol";
import { compile, httpOk, makeRef, toNodeMap } from "@puristic/deploy-protocol";
import { adminUsername } from "@puristic/deploy-resolvers";

// The standalone control plane: one Forgejo on a dedicated host, holding the intent and
// reconciliation-target repos. Distinct from the per-host application-plane Forgejo the app resolver
// derives — this one is stood up before any user intent exists and is not produced by resolve().
export interface ControlPlaneConfig {
    readonly host: {
        readonly address: string;
        readonly user: string;
        readonly sshKey: SecretRef;
        readonly port?: number;
    };
    // The control host's internal ip (Forgejo binds here) and the git domain it is reachable at.
    readonly internalIp: string;
    readonly domain: string;
    readonly adminPassword: SecretRef;
}

export const controlGitId = "control-git";
export const intentRepoId = "intent-repo";
export const targetRepoId = "reconciliation-target-repo";
export const intentRepoName = "intent";
export const targetRepoName = "reconciliation-target";
// Forgejo initializes auto-created repos on this branch.
export const controlBranch = "main";

// The control-plane desired-state graph: the Forgejo container plus the two repos that live in it. The
// repos depend on Forgejo (their baseUrl is its internal url) and are created once it is healthy.
export const buildControlPlaneGraph = (config: ControlPlaneConfig): DesiredStateGraph => {
    const ssh = {
        address: config.host.address,
        user: config.host.user,
        sshKey: config.host.sshKey,
        ...(config.host.port !== undefined ? { port: config.host.port } : {}),
    };
    const repo = (id: string, name: string) => ({
        id,
        type: "control-repo" as const,
        inputs: {
            baseUrl: makeRef(controlGitId, "internalUrl"),
            owner: adminUsername,
            name,
            private: true,
            adminUser: adminUsername,
            adminPassword: config.adminPassword,
        },
        explicitDependsOn: [controlGitId],
    });
    return compile(
        toNodeMap([
            {
                id: controlGitId,
                type: "forgejo",
                inputs: {
                    ...ssh,
                    internalIp: config.internalIp,
                    domain: config.domain,
                    adminUser: adminUsername,
                    adminPassword: config.adminPassword,
                },
                explicitDependsOn: [],
                readyWhen: httpOk(makeRef<string>(controlGitId, "internalUrl"), { timeout: "120s" }),
            },
            repo(intentRepoId, intentRepoName),
            repo(targetRepoId, targetRepoName),
        ]),
    );
};
