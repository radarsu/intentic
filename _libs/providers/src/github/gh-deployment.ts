import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs, sshSchema, sshTarget } from "../core/inputs.js";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";

const ghDeploymentSchema = z
    .object({
        owner: z.string(),
        repoName: z.string(),
        tag: z.string(),
        domain: z.string(),
        internalIp: z.string(),
        port: z.coerce.number(),
        env: z.record(z.string(), z.unknown()).default({}),
    })
    .merge(sshSchema);
type GhDeploymentInputs = z.infer<typeof ghDeploymentSchema>;
const parse = (inputs: ResolvedInputs): GhDeploymentInputs => parseInputs(ghDeploymentSchema, inputs, "gh-deployment");

const containerName = (ctx: { id: string }): string => ctx.id;
const ghcrImage = (parsed: GhDeploymentInputs): string => `ghcr.io/${parsed.owner}/${parsed.repoName}:${parsed.tag}`;

const outputsFor = (parsed: GhDeploymentInputs): Record<string, unknown> => ({
    url: `https://${parsed.domain}`,
    internalUrl: `http://${parsed.internalIp}:${parsed.port}`,
});

// One container on the host, managed directly via SSH (no Komodo). This is the deployment provider for the
// GitHub path. The container is started by the gh-ci workflow's SSH deploy step; this provider converges
// the state (ensures the container is running with the right image + env + ports).
export const createGhDeploymentProvider = (ssh: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        if (typeof inputs["address"] !== "string") {
            return undefined;
        }
        const parsed = parse(inputs);
        const name = containerName(ctx);
        try {
            const session = await ssh.connect(sshTarget(parsed));
            try {
                const result = await session.exec(`docker inspect --format '{{.State.Running}}' ${name} 2>/dev/null || echo "not-found"`);
                const output = result.stdout.trim();
                if (output === "not-found" || output === "") {
                    return undefined;
                }
                return { outputs: outputsFor(parsed), detail: { running: output === "true" } };
            } finally {
                await session.dispose();
            }
        } catch (error) {
            ctx.log(`gh-deployment "${ctx.id}": host not reachable yet: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        if (observed.detail?.["running"] !== true) {
            return { action: "update", reason: "container is not running" };
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const name = containerName(ctx);
        const img = ghcrImage(parsed);
        const envFlags = Object.entries(parsed.env)
            .map(([key, value]) => `-e ${key}='${String(value)}'`)
            .join(" ");
        const envStr = envFlags.length > 0 ? ` ${envFlags}` : "";

        const script = [
            `docker pull ${img}`,
            `docker stop ${name} 2>/dev/null || true`,
            `docker rm ${name} 2>/dev/null || true`,
            `docker run -d --name ${name} --restart unless-stopped -p ${parsed.port}:${parsed.port}${envStr} ${img}`,
        ].join(" && ");

        const session = await ssh.connect(sshTarget(parsed));
        try {
            await session.exec(script);
        } finally {
            await session.dispose();
        }
        return outputsFor(parsed);
    },
    delete: async (inputs, ctx) => {
        if (typeof inputs["address"] !== "string") {
            return;
        }
        const parsed = parse(inputs);
        const name = containerName(ctx);
        const session = await ssh.connect(sshTarget(parsed));
        try {
            await session.exec(`docker stop ${name} 2>/dev/null || true && docker rm ${name} 2>/dev/null || true`);
        } finally {
            await session.dispose();
        }
    },
});
