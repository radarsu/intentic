import tls from "node:tls";

// Validate an IMAP credential by logging in over implicit-TLS IMAP. No HTTP surface exists, so this speaks the
// protocol directly on a TLS socket: wait for the server greeting, send LOGIN, and read the tagged response.
// Returns true on `a1 OK`, false on `a1 NO`/`a1 BAD` (bad credential), and rejects on connection/timeout errors
// (so the provider treats an unreachable server as not-yet-validated). Injectable for tests, like StripeApi.
// ponytail: raw IMAP LOGIN over node:tls — swap for imapflow only if we ever need mailbox ops.

export interface ImapCredentials {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
}
export type ImapChecker = (creds: ImapCredentials) => Promise<boolean>;

// IMAP quoted-string: backslash-escape " and \.
const quote = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`;

export const imapLogin: ImapChecker = (creds) =>
    new Promise<boolean>((resolve, reject) => {
        const socket = tls.connect({ host: creds.host, port: creds.port, servername: creds.host });
        let buffer = "";
        let sentLogin = false;
        const finish = (settle: () => void): void => {
            socket.removeAllListeners();
            socket.end();
            settle();
        };
        socket.setTimeout(15_000, () => finish(() => reject(new Error(`IMAP ${creds.host}:${creds.port} timed out`))));
        socket.on("error", (error) => finish(() => reject(error)));
        socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (!sentLogin) {
                if (/^\* BYE/m.test(buffer)) {
                    finish(() => reject(new Error(`IMAP ${creds.host} refused the connection`)));
                    return;
                }
                if (!/^\* (OK|PREAUTH)/m.test(buffer)) {
                    return;
                }
                sentLogin = true;
                buffer = "";
                socket.write(`a1 LOGIN ${quote(creds.username)} ${quote(creds.password)}\r\n`);
                return;
            }
            const match = /^a1 (OK|NO|BAD)\b/im.exec(buffer);
            if (match) {
                finish(() => resolve(match[1]!.toUpperCase() === "OK"));
            }
        });
    });
