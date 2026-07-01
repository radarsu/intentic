import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import { type ImapChecker, imapLogin } from "./imap-check.js";

const imapSchema = z.object({ host: z.string(), port: z.number().default(993), username: z.string(), password: z.string() });
const parse = (inputs: ResolvedInputs): { host: string; port: number; username: string; password: string } =>
    parseInputs(imapSchema, inputs, "imap");

// An IMAP inbox as a validated external integration (v1: validate-only, non-destructive). `read` confirms the
// credential logs in (treating an unreachable server as not-yet-validated so plan stays forward-moving); `diff`
// is always noop (intentic mutates nothing on the mailbox); `apply` re-validates and throws on a rejected login.
export const createImapProvider = (check: ImapChecker = imapLogin): Provider => ({
    read: async (inputs, ctx) => {
        const creds = parse(inputs);
        try {
            return (await check(creds)) ? { outputs: {} } : undefined;
        } catch (error) {
            ctx.log(`imap "${ctx.id}": IMAP server not reachable, treating as not-yet-validated: ${String(error)}`);
            return undefined;
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        const creds = parse(inputs);
        if (!(await check(creds))) {
            throw new Error(`imap "${ctx.id}": the IMAP login was rejected. Check IMAP_PASSWORD in your .env.`);
        }
        return {};
    },
});
