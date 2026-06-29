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
    // Streamed binary file transfer over SFTP — the real executor only; test fakes may omit. Used to relay a
    // restic-repo tarball between two hosts THROUGH the CLI during a host migration, where neither host can
    // reach the other directly (a NAT'd local host opens no inbound ports). Streamed to/from a file, so a
    // multi-GB repo never buffers in memory the way `exec`'s string-collected stdout would.
    readonly download?: (remotePath: string, localPath: string) => Promise<void>;
    readonly upload?: (localPath: string, remotePath: string) => Promise<void>;
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

// Persists the public key each host presented, keyed by address:port — the trust store behind host-key
// verification. The CLI backs this with a committed `.known-hosts.json`; an embedded control plane injects
// its own per-tenant (DB/vault) implementation. Keys are the host's public key as base64.
export interface HostKeyStore {
    readonly get: (host: string, port: number) => Promise<string | undefined>;
    readonly set: (host: string, port: number, key: string) => Promise<void>;
}

// A process-lifetime store: trusts the first key seen per host and verifies later connects against it, but
// nothing survives the process. The default for `sshExecutor`, and the safe baseline for tests/e2e (fresh
// hosts re-pin per run).
export const inMemoryHostKeyStore = (): HostKeyStore => {
    const keys = new Map<string, string>();
    const id = (host: string, port: number): string => `${host}:${port}`;
    return {
        get: (host, port) => Promise.resolve(keys.get(id(host, port))),
        set: (host, port, key) => {
            keys.set(id(host, port), key);
            return Promise.resolve();
        },
    };
};

// Trust-on-first-use + pinning. An unseen host's key is recorded and trusted; a seen host must present the
// exact same key, or it is a mismatch (a possible MITM, or the host was rebuilt). Pure but for the store —
// unit-testable without a live SSH server.
export const verifyHostKey = async (store: HostKeyStore, host: string, port: number, presented: string): Promise<"ok" | "mismatch"> => {
    const known = await store.get(host, port);
    if (known === undefined) {
        await store.set(host, port, presented);
        return "ok";
    }
    return known === presented ? "ok" : "mismatch";
};

// Drain a readable stream into a boxed string sink (a box avoids reassigning a captured binding).
const collect = (stream: Readable, sink: { value: string }): void => {
    stream.on("data", (chunk: Buffer) => {
        sink.value += chunk.toString("utf8");
    });
};

// ssh2 is CommonJS with named exports (no default), so `import { Client }` is the correct interop form.
// Every connection verifies the host key against `store` (trust-on-first-use + pinning) before proceeding.
export const createSshExecutor = (store: HostKeyStore = inMemoryHostKeyStore()): SshExecutor => ({
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
                    // SFTP get/put over the same connection. ssh2 streams the transfer to/from the local path,
                    // so the bytes never pass through `exec`'s utf8 string sink (which would corrupt binary).
                    download: (remotePath, localPath) =>
                        new Promise<void>((resolveTransfer, rejectTransfer) => {
                            client.sftp((sftpError, sftp) => {
                                if (sftpError) {
                                    rejectTransfer(sftpError);
                                    return;
                                }
                                sftp.fastGet(remotePath, localPath, (getError) => (getError ? rejectTransfer(getError) : resolveTransfer()));
                            });
                        }),
                    upload: (localPath, remotePath) =>
                        new Promise<void>((resolveTransfer, rejectTransfer) => {
                            client.sftp((sftpError, sftp) => {
                                if (sftpError) {
                                    rejectTransfer(sftpError);
                                    return;
                                }
                                sftp.fastPut(localPath, remotePath, (putError) => (putError ? rejectTransfer(putError) : resolveTransfer()));
                            });
                        }),
                });
            });
            client.connect({
                host: target.address,
                port: target.port,
                username: target.user,
                privateKey: target.privateKey,
                // ssh2 hands us the host's public key (Buffer, since no hostHash is set) and waits for the
                // callback. A mismatch rejects the connect with a clear error before any command runs; a store
                // read failure also fails closed.
                hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
                    verifyHostKey(store, target.address, target.port, key.toString("base64"))
                        .then((outcome) => {
                            if (outcome === "mismatch") {
                                reject(
                                    new Error(
                                        `host key mismatch for ${target.address}:${target.port} — refusing to connect (possible MITM, or the host was rebuilt; remove its entry from .known-hosts.json to re-trust)`,
                                    ),
                                );
                            }
                            callback(outcome === "ok");
                        })
                        .catch(reject);
                },
            });
        }),
});

export const sshExecutor: SshExecutor = createSshExecutor();
