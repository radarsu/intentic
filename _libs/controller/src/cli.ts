#!/usr/bin/env node
import { env } from "@puristic/deploy-protocol";
import { bootstrap } from "./bootstrap.js";
import type { ControlPlaneConfig } from "./control-plane.js";
import { runController } from "./controller.js";
import { evaluateIntentSource } from "./evaluate-intent.js";

const requireEnv = (key: string): string => {
    const value = process.env[key];
    if (value === undefined || value === "") {
        throw new Error(`required env var "${key}" is not set`);
    }
    return value;
};

// The control plane reads its inventory from env: the control host to SSH into, and the env var names the
// SSH key and admin password are sourced from (resolved by the engine at apply time, never inlined).
const readConfig = (): ControlPlaneConfig => ({
    host: {
        address: requireEnv("PURISTIC_HOST_ADDRESS"),
        user: requireEnv("PURISTIC_HOST_USER"),
        sshKey: env("HOST_SSH_KEY"),
        ...(process.env["PURISTIC_HOST_PORT"] !== undefined ? { port: Number(process.env["PURISTIC_HOST_PORT"]) } : {}),
    },
    internalIp: requireEnv("PURISTIC_CONTROL_INTERNAL_IP"),
    domain: requireEnv("PURISTIC_CONTROL_DOMAIN"),
    adminPassword: env("FORGEJO_ADMIN_PASSWORD"),
});

const main = async (argv: readonly string[]): Promise<void> => {
    const [group, command] = argv;
    if (group !== "control-plane" || (command !== "up" && command !== "watch")) {
        throw new Error("usage: puristic control-plane <up|watch>");
    }
    if (command === "up") {
        const outcome = await bootstrap(readConfig());
        console.log(JSON.stringify(outcome, undefined, 4));
        return;
    }
    await runController({ config: readConfig(), evaluateIntent: evaluateIntentSource });
};

await main(process.argv.slice(2));
