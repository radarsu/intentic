import { makeRef } from "@intentic/graph";
import type { AppIntent, EnvironmentInput, IntentSet } from "@intentic/resolvers";
import { deploymentId, repoId } from "@intentic/resolvers";
import type { App, Deployment, Repo, Stack, WantAppInput } from "./handles.js";

// The builder is a pure intent recorder: i.want.app records what was declared and hands back typed handles
// for wiring. No derivation happens here — that is the resolver's job. The App handle's per-environment ids
// come from the same deploymentId() the resolver uses, so they cannot drift.
export const createStack = (): { stack: Stack; intent: IntentSet } => {
    const claimed = new Set<string>();
    const claim = (id: string): void => {
        if (claimed.has(id)) {
            throw new Error(`duplicate resource id: "${id}"`);
        }
        claimed.add(id);
    };

    const apps: AppIntent[] = [];

    const app = <const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string> => {
        claim(id);
        apps.push({
            id,
            ...(input.notify !== undefined ? { notify: input.notify } : {}),
            environments: input.environments,
        });

        const environments: Record<string, Deployment> = {};
        for (const name of Object.keys(input.environments)) {
            const did = deploymentId(id, name);
            environments[name] = Object.freeze({
                ...makeRef(did),
                internalUrl: makeRef<string>(did, "internalUrl"),
                url: makeRef<string>(did, "url"),
            }) as Deployment;
        }

        const rid = repoId(id);
        const repo = Object.freeze({ ...makeRef(rid), cloneUrl: makeRef<string>(rid, "cloneUrl"), sshUrl: makeRef<string>(rid, "sshUrl") }) as Repo;
        return Object.freeze({ ...makeRef(id), repo, environments: Object.freeze(environments) }) as App<keyof E & string>;
    };

    const stack: Stack = { want: { app } };
    return { stack, intent: { apps } };
};
