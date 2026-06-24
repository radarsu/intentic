import type { ResolvedInputs } from "@intentic/engine";
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

const issues = (error: z.ZodError): string => error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");

// Validate a node's resolved inputs against a schema, throwing the codebase's labelled
// "<resource> inputs malformed: …" error so callers (and tests) get a consistent, attributable message.
// This is an enriching transformation of the ZodError (like the API call() helpers), not a passthrough.
export const parseInputs = <S extends z.ZodType>(schema: S, inputs: ResolvedInputs, label: string): z.infer<S> => {
    const result = schema.safeParse(inputs);
    if (!result.success) {
        throw new Error(`${label} inputs malformed: ${issues(result.error)}`);
    }
    return result.data;
};

// Validate an EXTERNAL API response (untrusted, off the network) against the shape we consume, throwing a
// clear boundary error on drift instead of letting an unexpected payload surface as undefined deep inside
// a provider. Validates only the fields we read; unknown extra fields are dropped (additive API changes
// stay safe), while missing/renamed fields we depend on fail loudly here.
export const parseResponse = <S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`${label} returned an unexpected response: ${issues(result.error)}`);
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
