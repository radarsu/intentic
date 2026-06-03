import type { ResolvedInputs } from "@puristic/deploy-engine";
import { z } from "zod";
import type { SshTarget } from "./ssh.js";

// The SSH-creds block every host-deploying provider (host/tunnel/forgejo/forgejo-runner/komodo) shares;
// port defaults to 22 when absent, matching the engine's resolved-input shape.
export const sshSchema = z.object({
    address: z.string(),
    user: z.string(),
    sshKey: z.string(),
    port: z.number().default(22),
});

// Validate a node's resolved inputs against a schema, throwing the codebase's labelled
// "<resource> inputs malformed: …" error so callers (and tests) get a consistent, attributable message.
// This is an enriching transformation of the ZodError (like the API call() helpers), not a passthrough.
export const parseInputs = <S extends z.ZodType>(schema: S, inputs: ResolvedInputs, label: string): z.infer<S> => {
    const result = schema.safeParse(inputs);
    if (!result.success) {
        const detail = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");
        throw new Error(`${label} inputs malformed: ${detail}`);
    }
    return result.data;
};

// Map a parsed ssh block to the transport target (the sole sshKey -> privateKey mapping, centralized here).
export const sshTarget = (parsed: z.infer<typeof sshSchema>): SshTarget => ({
    address: parsed.address,
    user: parsed.user,
    privateKey: parsed.sshKey,
    port: parsed.port,
});
