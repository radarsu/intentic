import type { Ref } from "@puristic/deploy-protocol";
import { makeRef } from "@puristic/deploy-protocol";
import type { AppIntent, CloudflareInput, CloudflareIntent, EnvironmentInput, HostInput, HostIntent, IntentSet } from "@puristic/deploy-resolvers";
import { deploymentId } from "@puristic/deploy-resolvers";
import type { App, Cloudflare, Deployment, Host, Stack, WantAppInput } from "./handles.js";

// The builder is a pure intent recorder: i.have.* / i.want.app record what was declared and hand back
// typed handles for wiring. No derivation happens here — that is the resolver's job. The App handle's
// per-environment ids come from the same deploymentId() the resolver uses, so they cannot drift.
export const createStack = (): { stack: Stack; intent: IntentSet } => {
    const claimed = new Set<string>();
    const claim = (id: string): void => {
        if (claimed.has(id)) {
            throw new Error(`duplicate resource id: "${id}"`);
        }
        claimed.add(id);
    };

    const hosts: HostIntent[] = [];
    const clouds: CloudflareIntent[] = [];
    const apps: AppIntent[] = [];

    const ref = (resourceId: string, output: string): Ref<string> => makeRef(resourceId, output) as Ref<string>;

    const host = (id: string, input: HostInput): Host => {
        claim(id);
        hosts.push({ id, input });
        return Object.freeze({ ...makeRef(id), internalIp: ref(id, "internalIp"), publicIp: ref(id, "publicIp") }) as Host;
    };

    const cloudflare = (id: string, input: CloudflareInput): Cloudflare => {
        claim(id);
        clouds.push({ id, input });
        return Object.freeze({ ...makeRef(id), zoneId: ref(id, "zoneId") }) as Cloudflare;
    };

    const app = <const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string> => {
        claim(id);
        apps.push({ id, on: input.on.resourceId, expose: input.expose.resourceId, environments: input.environments });

        const environments: Record<string, Deployment> = {};
        for (const name of Object.keys(input.environments)) {
            const did = deploymentId(id, name);
            environments[name] = Object.freeze({ ...makeRef(did), internalUrl: ref(did, "internalUrl"), url: ref(did, "url") }) as Deployment;
        }
        return Object.freeze({ ...makeRef(id), environments: Object.freeze(environments) }) as App<keyof E & string>;
    };

    const stack: Stack = { have: { host, cloudflare }, want: { app } };
    return { stack, intent: { hosts, clouds, apps } };
};
