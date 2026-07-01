import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import { type OutlineApi, outlineApi } from "./outline-api.js";

const outlineSchema = z.object({ url: z.string(), apiKey: z.string() });
const parse = (inputs: ResolvedInputs): { url: string; apiKey: string } => parseInputs(outlineSchema, inputs, "outline");

// Outline as a validated external integration (v1: validate-only, non-destructive). `read` confirms the API token
// resolves a live user (treating an unreachable instance as not-yet-validated so plan stays forward-moving);
// `diff` is always noop (intentic mutates nothing on Outline yet); `apply` re-validates and throws on a rejected
// token. The token itself is injected into consuming apps as a $secret env elsewhere — this node only proves it works.
export const createOutlineProvider = (api: OutlineApi = outlineApi): Provider => ({
    read: async (inputs, ctx) => {
        const { url, apiKey } = parse(inputs);
        try {
            const user = await api.getAuthInfo(url, apiKey);
            return user === undefined ? undefined : { outputs: {} };
        } catch (error) {
            ctx.log(`outline "${ctx.id}": Outline instance not reachable, treating as not-yet-validated: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const { url, apiKey } = parse(inputs);
        const user = await api.getAuthInfo(url, apiKey);
        if (user === undefined) {
            throw new Error(`outline "${ctx.id}": the Outline API token was rejected. Check OUTLINE_API_KEY in your .env.`);
        }
        return {};
    },
});
