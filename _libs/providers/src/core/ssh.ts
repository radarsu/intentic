import { type ChildProcess, spawn } from "node:child_process";
import { createServer, connect as tcpConnect } from "node:net";
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
    // How to reach the host. "direct" (default) dials address:port over TCP. "cloudflared" reaches a NAT'd
    // host's SSH through its Cloudflare tunnel: the executor runs `cloudflared access tcp` to bridge the
    // tunnel hostname (address) to a local port and dials that instead. See createSshExecutor.
    readonly via?: "direct" | "cloudflared";
}

// The transport the host provider runs commands over. Injected so the provider is unit-testable with a
// fake; the default is the ssh2-backed executor below. `dispose` tears down any cloudflared forwarders the
// executor started (a no-op for direct-only runs); the CLI calls it when a command finishes.
export interface SshExecutor {
    readonly connect: (target: SshTarget) => Promise<SshSession>;
    readonly dispose?: () => Promise<void>;
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
const hostKeyId = (host: string, port: number): string => `${host}:${port}`;

export const inMemoryHostKeyStore = (): HostKeyStore => {
    const keys = new Map<string, string>();
    return {
        get: (host, port) => Promise.resolve(keys.get(hostKeyId(host, port))),
        set: (host, port, key) => {
            keys.set(hostKeyId(host, port), key);
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

// A running `cloudflared access tcp` forwarder: a local listener on `port` that bridges to a host's SSH over
// its Cloudflare tunnel. One per tunnel hostname, reused across the many SSH sessions an apply opens.
interface CloudflaredForwarder {
    readonly port: number;
    readonly child: ChildProcess;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Reserve a free loopback port by briefly binding :0, then release it for cloudflared to claim. A tiny race
// window (the port could be taken in between), acceptable for a one-shot per-host forwarder.
const reserveLocalPort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

// One TCP connect attempt to a loopback port; resolves whether it accepted.
const tcpProbe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = tcpConnect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });

// Poll a loopback port until it accepts; fail fast if cloudflared exited first (reported via `failure`).
const waitForPort = async (port: number, failure: () => string | undefined, timeoutMs = 20000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const reason = failure();
        if (reason !== undefined) {
            throw new Error(`cloudflared access exited before its local forwarder came up: ${reason}`);
        }
        if (await tcpProbe(port)) {
            return;
        }
        if (Date.now() > deadline) {
            throw new Error(`cloudflared local forwarder on 127.0.0.1:${port} did not come up within ${timeoutMs}ms`);
        }
        await delay(150);
    }
};

// Start `cloudflared access tcp --hostname <hostname> --url 127.0.0.1:<port>` and resolve once the local
// listener accepts. cloudflared must be on PATH (the sandbox image ships it). Rejects if the binary is
// missing or the listener never comes up.
const startCloudflaredForwarder = async (hostname: string): Promise<CloudflaredForwarder> => {
    const port = await reserveLocalPort();
    const child = spawn("cloudflared", ["access", "tcp", "--hostname", hostname, "--url", `127.0.0.1:${port}`], { stdio: "ignore" });
    let exit: string | undefined;
    child.once("error", (error) => {
        exit = `spawn failed: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
        exit = `exited (code ${code ?? "?"}, signal ${signal ?? "none"})`;
    });
    try {
        await waitForPort(port, () => exit);
    } catch (error) {
        child.kill();
        throw error;
    }
    return { port, child };
};

// ssh2 is CommonJS with named exports (no default), so `import { Client }` is the correct interop form.
// Every connection verifies the host key against `store` (trust-on-first-use + pinning) before proceeding.
// A target with via:"cloudflared" is dialed through a per-host `cloudflared access tcp` forwarder (memoized
// so the many sessions of one apply share it); ssh2 connects to the local forwarder port, but the host-key
// store stays keyed on the LOGICAL address:port, so TOFU pinning is stable across runs.
export const createSshExecutor = (store: HostKeyStore = inMemoryHostKeyStore()): SshExecutor => {
    const forwarders = new Map<string, Promise<CloudflaredForwarder>>();

    const dial = async (target: SshTarget): Promise<{ host: string; port: number }> => {
        if (target.via !== "cloudflared") {
            return { host: target.address, port: target.port };
        }
        let forwarder = forwarders.get(target.address);
        if (forwarder === undefined) {
            forwarder = startCloudflaredForwarder(target.address);
            forwarders.set(target.address, forwarder);
            // A failed start must not poison the cache — drop it so a later connect can retry.
            forwarder.catch(() => forwarders.delete(target.address));
        }
        return { host: "127.0.0.1", port: (await forwarder).port };
    };

    return {
        connect: async (target) => {
            const endpoint = await dial(target);
            return new Promise<SshSession>((resolve, reject) => {
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
                    host: endpoint.host,
                    port: endpoint.port,
                    username: target.user,
                    privateKey: target.privateKey,
                    // ssh2 hands us the host's public key (Buffer, since no hostHash is set) and waits for the
                    // callback. A mismatch rejects the connect with a clear error before any command runs; a store
                    // read failure also fails closed. Keyed on the LOGICAL address:port, not the local forwarder.
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
            });
        },
        dispose: async () => {
            const pending = [...forwarders.values()];
            forwarders.clear();
            await Promise.all(
                pending.map(async (forwarder) => {
                    try {
                        (await forwarder).child.kill();
                    } catch {
                        // Forwarder failed to start or already exited — nothing to tear down.
                    }
                }),
            );
        },
    };
};

export const sshExecutor: SshExecutor = createSshExecutor();
