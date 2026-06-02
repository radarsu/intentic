import type { Provider, ResolvedInputs } from "@puristic/deploy-engine";
import type { SshExecutor, SshSession, SshTarget } from "./ssh.js";
import { sshExecutor } from "./ssh.js";

interface HostInputs {
    readonly address: string;
    readonly user: string;
    readonly privateKey: string;
    readonly port: number;
}

const parseHostInputs = (inputs: ResolvedInputs): HostInputs => {
    const address = inputs["address"];
    const user = inputs["user"];
    const sshKey = inputs["sshKey"];
    const port = inputs["port"];
    if (typeof address !== "string" || typeof user !== "string" || typeof sshKey !== "string") {
        throw new Error(`host inputs malformed: address/user/sshKey must be strings (got ${typeof address}/${typeof user}/${typeof sshKey})`);
    }
    if (port !== undefined && typeof port !== "number") {
        throw new Error(`host input "port" must be a number when present (got ${typeof port})`);
    }
    return { address, user, privateKey: sshKey, port: port ?? 22 };
};

const target = (parsed: HostInputs): SshTarget => ({ address: parsed.address, user: parsed.user, privateKey: parsed.privateKey, port: parsed.port });

// Gather the host's facts over an open session. The host is OWNED infra — this verifies it is reachable
// and Docker-ready and reads its addresses; it does not provision anything. internalIp is the default
// route's source address; publicIp is the address we connect to (no third-party egress).
const gather = async (session: SshSession, address: string): Promise<Record<string, unknown>> => {
    const docker = await session.exec("docker version --format '{{.Server.Version}}'");
    if (docker.code !== 0) {
        throw new Error(`host is not Docker-ready: \`docker version\` exited ${docker.code}: ${docker.stderr.trim()}`);
    }
    const route = await session.exec("ip -4 -o route get 1.1.1.1 | awk '{print $7; exit}'");
    if (route.code !== 0) {
        throw new Error(`failed to read host internal ip: exited ${route.code}: ${route.stderr.trim()}`);
    }
    return { internalIp: route.stdout.trim(), publicIp: address };
};

// The host provider. read/apply both connect-and-gather; diff is always noop (an owned host has no
// managed drift). read maps a connection failure to "not yet reachable" (undefined) so a plan can report
// it without aborting; apply lets a connection failure propagate as the hard error for owned infra.
export const createHostProvider = (executor: SshExecutor = sshExecutor): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parseHostInputs(inputs);
        let session: SshSession;
        try {
            session = await executor.connect(target(parsed));
        } catch (error) {
            ctx.log(`host "${ctx.id}" is not reachable over SSH, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
        try {
            return { outputs: await gather(session, parsed.address) };
        } finally {
            await session.dispose();
        }
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs) => {
        const parsed = parseHostInputs(inputs);
        const session = await executor.connect(target(parsed));
        try {
            return await gather(session, parsed.address);
        } finally {
            await session.dispose();
        }
    },
});
