import { env } from "@intentic/graph";
import type { ControlPlaneConfig } from "./control-plane.js";

// CLI flags that source the control-plane config. Each falls back to its original env var, so `intentic`
// still runs purely from the environment while flags allow per-invocation overrides.
export interface ControlPlaneFlags {
    readonly hostAddress?: string;
    readonly hostUser?: string;
    readonly hostPort?: number;
    readonly internalIp?: string;
    readonly domain?: string;
}

const required = (flag: string | undefined, flagName: string, envKey: string): string => {
    const value = flag ?? process.env[envKey];
    if (value === undefined || value === "") {
        throw new Error(`missing ${flagName}: pass --${flagName} or set env "${envKey}"`);
    }
    return value;
};

// Secrets stay as env() references resolved at apply time by the engine (and read at runtime by the
// controller via their .key) — never read here, so they are never placed on argv.
export const readConfig = (flags: ControlPlaneFlags): ControlPlaneConfig => {
    const port = flags.hostPort ?? (process.env["INTENTIC_HOST_PORT"] !== undefined ? Number(process.env["INTENTIC_HOST_PORT"]) : undefined);
    return {
        host: {
            address: required(flags.hostAddress, "host-address", "INTENTIC_HOST_ADDRESS"),
            user: required(flags.hostUser, "host-user", "INTENTIC_HOST_USER"),
            sshKey: env("HOST_SSH_KEY"),
            ...(port !== undefined ? { port } : {}),
        },
        internalIp: required(flags.internalIp, "internal-ip", "INTENTIC_CONTROL_INTERNAL_IP"),
        domain: required(flags.domain, "domain", "INTENTIC_CONTROL_DOMAIN"),
        adminPassword: env("FORGEJO_ADMIN_PASSWORD"),
    };
};
