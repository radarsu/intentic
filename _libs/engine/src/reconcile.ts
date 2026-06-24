import { refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resolvers";
import type { Provider, ProviderContext, Providers } from "./provider.js";
import type { OutputStore } from "./store.js";

export const requireProvider = (providers: Providers, type: ResourceType, id: string): Provider => {
    const provider = providers[type];
    if (provider === undefined) {
        throw new Error(`no provider registered for type "${type}" (resource "${id}")`);
    }
    return provider;
};

export const makeContext = (
    id: string,
    store: OutputStore,
    env: Readonly<Record<string, string | undefined>>,
    log: (message: string) => void,
): ProviderContext => ({
    env,
    log,
    id,
    output: (depId, name) => store.get(refKey(depId, name), { lenient: false }),
});
