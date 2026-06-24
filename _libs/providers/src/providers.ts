import type { Providers } from "@intentic/engine";
import { createAppProvider } from "./app.js";
import { createCfRouteProvider } from "./cf-route.js";
import { createCloudflareProvider } from "./cloudflare.js";
import type { CloudflareApi } from "./cloudflare-api.js";
import { cloudflareApi } from "./cloudflare-api.js";
import { createDeployHookProvider } from "./deploy-hook.js";
import { createDeploymentProvider } from "./deployment.js";
import { createForgejoProvider } from "./forgejo.js";
import type { ForgejoApi } from "./forgejo-api.js";
import { forgejoApi } from "./forgejo-api.js";
import { createForgejoNotifyProvider } from "./forgejo-notify.js";
import { createForgejoRunnerProvider } from "./forgejo-runner.js";
import { createHostProvider } from "./host.js";
import { createKomodoProvider } from "./komodo.js";
import type { KomodoApi } from "./komodo-api.js";
import { komodoApi } from "./komodo-api.js";
import { createKomodoNotifyProvider } from "./komodo-notify.js";
import { createRepoProvider } from "./repo.js";
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
}

// Assemble the full ResourceType -> Provider map the engine reconciles against. This is the single seam
// between a compiled graph and execution: the engine never constructs providers, it is handed this map.
export const createProviders = (deps: ProviderDeps = {}): Providers => {
    const ssh = deps.ssh ?? sshExecutor;
    const cloudflare = deps.cloudflare ?? cloudflareApi;
    const forgejo = deps.forgejo ?? forgejoApi;
    const komodo = deps.komodo ?? komodoApi;
    return {
        host: createHostProvider(ssh),
        cloudflare: createCloudflareProvider(cloudflare),
        "cf-route": createCfRouteProvider(cloudflare),
        tunnel: createTunnelProvider(cloudflare, ssh),
        forgejo: createForgejoProvider(ssh),
        "forgejo-runner": createForgejoRunnerProvider(ssh),
        komodo: createKomodoProvider(ssh),
        repo: createRepoProvider(forgejo),
        app: createAppProvider(komodo),
        deployment: createDeploymentProvider(komodo),
        "forgejo-notify": createForgejoNotifyProvider(forgejo),
        "komodo-notify": createKomodoNotifyProvider(komodo),
        "deploy-hook": createDeployHookProvider(forgejo),
    };
};
