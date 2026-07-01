import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import { type RedmineApi, redmineApi } from "./redmine-api.js";

const redmineSchema = z.object({ url: z.string(), apiKey: z.string() });
const parse = (inputs: ResolvedInputs): { url: string; apiKey: string } => parseInputs(redmineSchema, inputs, "redmine");

// Redmine as a validated external integration (v1: validate-only, non-destructive). `read` confirms the API key
// resolves a live user (treating an unreachable instance as not-yet-validated so plan stays forward-moving);
// `diff` is always noop (intentic mutates nothing on Redmine yet); `apply` re-validates and throws on a rejected
// key. The key itself is injected into consuming apps as a $secret env elsewhere — this node only proves it works.
export const createRedmineProvider = (api: RedmineApi = redmineApi): Provider => ({
    read: async (inputs, ctx) => {
        const { url, apiKey } = parse(inputs);
        try {
            const user = await api.getCurrentUser(url, apiKey);
            return user === undefined ? undefined : { outputs: {} };
        } catch (error) {
            ctx.log(`redmine "${ctx.id}": Redmine instance not reachable, treating as not-yet-validated: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const { url, apiKey } = parse(inputs);
        const user = await api.getCurrentUser(url, apiKey);
        if (user === undefined) {
            throw new Error(`redmine "${ctx.id}": the Redmine API key was rejected. Check REDMINE_API_KEY in your .env.`);
        }
        return {};
    },
});
