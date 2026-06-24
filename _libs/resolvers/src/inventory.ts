import type { SecretRef } from "@intentic/graph";
import { env } from "@intentic/graph";

// The implicit, reconciled inventory. Intent is now "what you want" only; the host and Cloudflare account
// are no longer authored. They are resource nodes in the desired-state artifact whose connection
// values are canonical env secrets, filled during the decision/PR step. There is exactly one of each,
// shared by every app, and their ids are fixed so the derived graph stays stable.
export const HOST_ID = "host";
export const CLOUDFLARE_ID = "cf";

export interface HostConnection {
    readonly address: SecretRef;
    readonly user: SecretRef;
    readonly sshKey: SecretRef;
}

// The host's SSH connection, sourced from canonical env secrets (SSH port is the default 22).
export const hostConnection: HostConnection = {
    address: env("HOST_ADDRESS"),
    user: env("HOST_USER"),
    sshKey: env("HOST_SSH_KEY"),
};

export const cloudflareAccountId: SecretRef = env("CLOUDFLARE_ACCOUNT_ID");
export const cloudflareApiToken: SecretRef = env("CLOUDFLARE_API_TOKEN");

// The leftmost-stripped parent of a domain — its zone, e.g. staging.example.com -> example.com.
const parentZone = (domain: string): string => {
    const labels = domain.split(".");
    if (labels.length < 3) {
        throw new Error(`domain "${domain}" must be a subdomain of your zone (e.g. app.example.com)`);
    }
    return labels.slice(1).join(".");
};

// The Cloudflare DNS zone, derived from the apps' environment domains. The platform hostnames
// (git.<zone>/komodo.<zone>) and the cf-route hostnames must be literals at compile time, so the zone
// cannot be a deferred secret — every domain must resolve to one shared parent zone.
export const deriveZone = (domains: readonly string[]): string => {
    if (domains.length === 0) {
        throw new Error("cannot derive a Cloudflare zone: no environment domains declared");
    }
    const zones = new Set(domains.map(parentZone));
    if (zones.size > 1) {
        throw new Error(`environment domains span multiple zones (${[...zones].sort().join(", ")}); they must share one`);
    }
    return [...zones][0] as string;
};
