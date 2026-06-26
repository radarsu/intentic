import type { Providers } from "@intentic/engine";
import { createBackupProvider } from "./backup.js";
import { createCfRouteProvider, type DnsPropagationWait } from "./cf-route.js";
import { createCiProvider } from "./ci.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import { createDeploymentProvider } from "./deployment.js";
import { createForgejoProvider } from "./forgejo.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { createForgejoNotifyProvider } from "./forgejo-notify.js";
import { createForgejoOrgProvider } from "./forgejo-org.js";
import { createForgejoRunnerProvider } from "./forgejo-runner.js";
import { createForgejoTeamProvider } from "./forgejo-team.js";
import { createForgejoUserProvider } from "./forgejo-user.js";
import { createGhCiProvider } from "./gh-ci.js";
import { createGhDeploymentProvider } from "./gh-deployment.js";
import { createGhRepoProvider } from "./gh-repo.js";
import { createGitHubProvider } from "./github.js";
import type { GitHubApi } from "./github-api.js";
import { githubApi } from "./github-api.js";
import { createHostProvider } from "./host.js";
import { createKomodoProvider } from "./komodo.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { createKomodoNotifyProvider } from "./komodo-notify.js";
import { createKomodoPeripheryProvider } from "./komodo-periphery.js";
import { createKomodoServerProvider } from "./komodo-server.js";
import { createKomodoUserProvider } from "./komodo-user.js";
import { createRepoProvider } from "./repo.js";
import { createSignozProvider } from "./signoz.js";
import type { SshExecutor } from "./ssh.js";
import { sshExecutor } from "./ssh.js";
import { createTunnelProvider } from "./tunnel.js";

// The four side-effecting dependencies every provider is built over: SSH transport to the host and the
// three external HTTP surfaces. Each defaults to its real implementation; pass a fake to drive the whole
// suite in-memory (tests) or a real one to reconcile against live infra (the e2e harness, a future CLI).
export interface ProviderDeps {
    readonly ssh?: SshExecutor;
    readonly cloudflare?: CloudflareApi;
    readonly forgejo?: ForgejoApi;
    readonly komodo?: KomodoApi;
    readonly github?: GitHubApi;
    // The cf-route DNS-propagation wait; defaults to the real DoH probe. In-memory tests inject a no-op so
    // they never hit the network.
    readonly dnsPropagation?: DnsPropagationWait;
}

// Assemble the full ResourceType -> Provider map the engine reconciles against. This is the single seam
// between a compiled graph and execution: the engine never constructs providers, it is handed this map.
export const createProviders = (deps: ProviderDeps = {}): Providers => {
    const ssh = deps.ssh ?? sshExecutor;
    const cloudflare = deps.cloudflare ?? cloudflareApi;
    const forgejo = deps.forgejo ?? forgejoApi;
    const komodo = deps.komodo ?? komodoApi;
    const github = deps.github ?? githubApi;
    return {
        host: createHostProvider(ssh),
        cloudflare: createCloudflareProvider(cloudflare),
        "cf-route": createCfRouteProvider(cloudflare, deps.dnsPropagation),
        tunnel: createTunnelProvider(cloudflare, ssh),
        forgejo: createForgejoProvider(ssh),
        "forgejo-user": createForgejoUserProvider(forgejo),
        "forgejo-org": createForgejoOrgProvider(forgejo),
        "forgejo-team": createForgejoTeamProvider(forgejo),
        "forgejo-runner": createForgejoRunnerProvider(ssh),
        komodo: createKomodoProvider(ssh),
        "komodo-periphery": createKomodoPeripheryProvider(ssh),
        "komodo-server": createKomodoServerProvider(komodo),
        "komodo-user": createKomodoUserProvider(komodo),
        repo: createRepoProvider(forgejo),
        ci: createCiProvider(forgejo),
        deployment: createDeploymentProvider(komodo),
        "forgejo-notify": createForgejoNotifyProvider(forgejo),
        "komodo-notify": createKomodoNotifyProvider(komodo),
        signoz: createSignozProvider(ssh),
        backup: createBackupProvider(ssh),
        github: createGitHubProvider(github),
        "gh-repo": createGhRepoProvider(github),
        "gh-ci": createGhCiProvider(github),
        "gh-deployment": createGhDeploymentProvider(ssh),
    };
};
