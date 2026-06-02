import type { Readable } from "node:stream";
import { Client } from "ssh2";

export interface SshResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export interface SshSession {
    readonly exec: (command: string) => Promise<SshResult>;
    readonly dispose: () => Promise<void>;
}

export interface SshTarget {
    readonly address: string;
    readonly user: string;
    readonly privateKey: string;
    readonly port: number;
}

// The transport the host provider runs commands over. Injected so the provider is unit-testable with a
// fake; the default is the ssh2-backed executor below.
export interface SshExecutor {
    readonly connect: (target: SshTarget) => Promise<SshSession>;
}

// Drain a readable stream into a boxed string sink (a box avoids reassigning a captured binding).
const collect = (stream: Readable, sink: { value: string }): void => {
    stream.on("data", (chunk: Buffer) => {
        sink.value += chunk.toString("utf8");
    });
};

// ssh2 is CommonJS with named exports (no default), so `import { Client }` is the correct interop form.
export const sshExecutor: SshExecutor = {
    connect: (target) =>
        new Promise<SshSession>((resolve, reject) => {
            const client = new Client();
            // Connect/auth failures surface here; removed once ready so a later disconnect can't reject twice.
            client.on("error", reject);
            client.on("ready", () => {
                client.removeListener("error", reject);
                resolve({
                    exec: (command) =>
                        new Promise<SshResult>((resolveExec, rejectExec) => {
                            client.exec(command, (error, stream) => {
                                if (error !== undefined) {
                                    rejectExec(error);
                                    return;
                                }
                                const stdout = { value: "" };
                                const stderr = { value: "" };
                                let code = 0;
                                collect(stream, stdout);
                                collect(stream.stderr, stderr);
                                // The exit code arrives on "exit"; "close" fires after streams flush.
                                stream.on("exit", (exitCode: number | null) => {
                                    code = exitCode ?? 0;
                                });
                                stream.on("close", () => {
                                    resolveExec({ stdout: stdout.value, stderr: stderr.value, code });
                                });
                            });
                        }),
                    dispose: () =>
                        new Promise<void>((resolveDispose) => {
                            client.on("close", () => {
                                resolveDispose();
                            });
                            client.end();
                        }),
                });
            });
            // No hostVerifier: accepts any host key (acceptable for owned infra on a trusted network in v1).
            client.connect({ host: target.address, port: target.port, username: target.user, privateKey: target.privateKey });
        }),
};
