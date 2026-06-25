import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cloudflareApi, forgejoApi, sshExecutor } from "@intentic/providers";
import { deploymentId, deploymentPort } from "@intentic/state-resolver";
import { readGeneratedSecrets } from "./generated-secrets.js";

// ssh2 is CommonJS; under raw Node ESM `import { utils }` can't be resolved as a named export, so load it
// through createRequire (the keygen is the only piece we need).
const { utils } = createRequire(import.meta.url)("ssh2") as {
    utils: { generateKeyPairSync: (type: string) => { private: string; public: string } };
};

// A PERSISTENT local demo of the whole intentic flow: boots a long-lived Docker-in-Docker "host" on this
// machine, drives the real CLI (init/resolve/apply) to stand up Forgejo + Komodo behind a Cloudflare tunnel
// and to WIRE the app's CI/CD (Forgejo Actions workflow + a Komodo registry deployment). intentic itself
// never builds or deploys the app — pushing the Dockerfile triggers the Action, which builds + pushes the
// image and Komodo rolls it out. Prints the live URLs + generated admin logins and LEAVES everything running
// so the services can be browsed. `demo down` tears it all back down (host container + tunnel + DNS). This is
// a dev harness — not a shipped `intentic` command — and reuses exactly what the e2e proved.

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliJs = join(repoRoot, "_apps/cli/dist/cli.js");
const stateDir = join(repoRoot, ".demo");
const stateFile = join(stateDir, "state.json");

const CONTAINER = "intentic-demo-host";
const TUNNEL = "intentic-host"; // resolver's tunnelName(host.id) — what cleanup finds it by
const ADMIN = "intentic"; // resolver's adminUsername — the Forgejo/Komodo admin login
const APP = "app";
const ENV = "production";
const APP_BODY = "intentic-demo-live";
const appPort = deploymentPort(deploymentId(APP, ENV));

const zone = process.env["CLOUDFLARE_ZONE"] ?? "intentic.dev";
const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "14aaba5ad087e7ed506d1470b14489ab";
const sshPort = Number(process.env["DEMO_SSH_PORT"] ?? "2222");
// Forgejo (3000) and Komodo (9120) are also published straight to localhost so the stack can be browsed
// and the app repo seeded WITHOUT waiting on public DNS — the tunnel/public URLs come up alongside.
const forgejoPort = Number(process.env["DEMO_FORGEJO_PORT"] ?? "3000");
const komodoPort = Number(process.env["DEMO_KOMODO_PORT"] ?? "9120");

const GIT_URL = `https://git.${zone}`;
const KOMODO_URL = `https://komodo.${zone}`;
const APP_URL = `https://app.${zone}`;

const log = (message: string): void => {
    process.stdout.write(`${message}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The engine reaches Forgejo/Komodo over their public URLs; route the CLI children's lookups for the demo
// zone through Cloudflare DoH so the just-created records resolve despite this machine's negative cache.
const dohHook = pathToFileURL(join(repoRoot, "_apps/cli/doh-lookup.mjs")).href;
const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_DOH_ZONE: zone,
    NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import=${dohHook}`.trim(),
};

// Stream a child's output so the operator watches the real apply progress; reject on non-zero exit.
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "inherit", "inherit"] });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
            }
        });
    });
const runCli = (...args: string[]): Promise<void> => run(process.execPath, [cliJs, ...args], cliEnv);
const quiet = async (command: string, args: string[]): Promise<boolean> => {
    try {
        await exec(command, args, { maxBuffer: 16 * 1024 * 1024 });
        return true;
    } catch {
        return false;
    }
};

const readToken = async (): Promise<string> => {
    const fromEnv = process.env["CLOUDFLARE_API_TOKEN"];
    if (fromEnv !== undefined && fromEnv !== "") {
        return fromEnv.replace(/\\/g, "").trim();
    }
    const envText = await readFile(join(repoRoot, "desired-state/.env"), "utf8");
    const match = /^CLOUDFLARE_API_TOKEN=(.*)$/m.exec(envText);
    if (match?.[1] === undefined) {
        throw new Error("CLOUDFLARE_API_TOKEN is not set and was not found in desired-state/.env");
    }
    return match[1].replace(/\\/g, "").trim();
};

const deployConfig = (withEnv: boolean): string => `import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    const host = i.have.host("host", {
        address: "127.0.0.1",
        user: "root",
        sshKey: env("HOST_SSH_KEY"),
        port: ${sshPort},
    });

    const cf = i.have.cloudflare("cf", {
        accountId: ${JSON.stringify(accountId)},
        apiToken: env("CLOUDFLARE_API_TOKEN"),
        zone: ${JSON.stringify(zone)},
    });

    i.want.app(${JSON.stringify(APP)}, {
        on: host,
        expose: cf,
        environments: ${
            withEnv
                ? `{
            ${ENV}: { domain: ${JSON.stringify(`app.${zone}`)}, branch: "main", env: { PORT: ${JSON.stringify(String(appPort))} } },
        }`
                : "{}"
        },
    });
});
`;

// Only the externals intentic can't invent; the Forgejo/Komodo admin passwords are intentic-generated into
// desired-state/.secrets.json by resolve/apply (we read them back below to sign in).
const envFile = (privateKey: string, apiToken: string): string =>
    `HOST_SSH_KEY="${privateKey}"
CLOUDFLARE_API_TOKEN=${apiToken}
`;

// A trivial buildable app: busybox httpd serving a known body on $PORT (Komodo sets PORT to appPort).
const DOCKERFILE = `FROM busybox
RUN mkdir -p /www && printf '%s' '${APP_BODY}' > /www/index.html
ENV PORT=8080
EXPOSE 8080
CMD ["sh","-c","httpd -f -v -p \${PORT} -h /www"]
`;

const ssh = async (command: string): Promise<string> => {
    const session = await sshExecutor.connect({ address: "127.0.0.1", port: sshPort, user: "root", privateKey });
    try {
        const result = await session.exec(command);
        return `${result.stdout}${result.stderr}`;
    } finally {
        await session.dispose();
    }
};

let privateKey = "";

const up = async (): Promise<void> => {
    const apiToken = await readToken();
    const keys = utils.generateKeyPairSync("ed25519");
    privateKey = keys.private;
    // Filled after the platform apply, from the secrets intentic generated into desired-state/.secrets.json.
    let forgejoPassword = "";
    let komodoPassword = "";

    log(`▶ building the demo host image (${CONTAINER}) from test/host …`);
    await run("docker", ["build", "-t", CONTAINER, join(repoRoot, "test/host")]);

    log("▶ starting the persistent Docker-in-Docker host …");
    await quiet("docker", ["rm", "-f", CONTAINER]);
    await run("docker", [
        "run",
        "-d",
        "--privileged",
        "--name",
        CONTAINER,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-p",
        `${sshPort}:22`,
        "-p",
        `${forgejoPort}:3000`,
        "-p",
        `${komodoPort}:9120`,
        CONTAINER,
    ]);

    log("▶ injecting the demo SSH key …");
    for (let i = 0; i < 60 && !(await quiet("docker", ["exec", CONTAINER, "true"])); i++) {
        await sleep(1000);
    }
    await exec("docker", [
        "exec",
        CONTAINER,
        "sh",
        "-c",
        `mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\\n' '${keys.public}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
    ]);

    log(`▶ waiting for SSH on 127.0.0.1:${sshPort} …`);
    for (let i = 0; ; i++) {
        try {
            await (await sshExecutor.connect({ address: "127.0.0.1", port: sshPort, user: "root", privateKey })).dispose();
            break;
        } catch (error) {
            if (i >= 90) {
                throw new Error(`host SSH never came up: ${String(error)}`);
            }
            await sleep(1000);
        }
    }

    const workspace = await mkdtemp(join(tmpdir(), "intentic-demo-"));
    const configPath = join(workspace, "intent", "deploy.config.ts");
    const artifactPath = join(workspace, "desired-state", "desired-state.json");

    // Persist enough state up front that `demo down` can always clean up, even if a later step fails.
    await mkdir(stateDir, { recursive: true });
    await writeFile(
        stateFile,
        JSON.stringify(
            {
                zone,
                accountId,
                apiToken,
                container: CONTAINER,
                sshPort,
                workspace,
                urls: { git: GIT_URL, komodo: KOMODO_URL, app: APP_URL },
                local: { git: `http://127.0.0.1:${forgejoPort}`, komodo: `http://127.0.0.1:${komodoPort}` },
            },
            null,
            2,
        ),
    );

    log("▶ scaffolding the intent (init --link) …");
    await runCli("init", "--dir", workspace, "--link");
    await writeFile(configPath, deployConfig(false));
    await writeFile(join(workspace, "desired-state", ".env"), envFile(privateKey, apiToken));

    log("▶ phase 1 — resolve + apply (Forgejo + Komodo + tunnel) …");
    await runCli("resolve", "--config", configPath, "--out", artifactPath);
    await runCli("apply", "--artifact", artifactPath, "--maxIterations", "8");

    // Read the admin passwords intentic generated (resolve wrote desired-state/.secrets.json), so the rest of
    // the demo signs in with exactly what bootstrapped Forgejo/Komodo.
    const secrets = await readGeneratedSecrets(join(workspace, "desired-state"));
    forgejoPassword = secrets["FORGEJO_ADMIN_PASSWORD"] ?? "";
    komodoPassword = secrets["KOMODO_ADMIN_PASSWORD"] ?? "";

    const running = await ssh("docker ps --format '{{.Names}}'");
    for (const name of ["intentic-forgejo", "intentic-forgejo-runner", "komodo-core"]) {
        if (!running.includes(name)) {
            throw new Error(`platform container "${name}" is not running on the host:\n${running}`);
        }
    }
    log(`✅ platform up — host containers: ${running.split("\n").filter(Boolean).join(", ")}`);

    log("▶ seeding the app repo (intentic/app @ main) with a Dockerfile …");
    let appDeployed = false;
    try {
        await forgejoApi.commitFile({
            baseUrl: `http://127.0.0.1:${forgejoPort}`,
            user: ADMIN,
            password: forgejoPassword,
            owner: ADMIN,
            name: APP,
            branch: "main",
            path: "Dockerfile",
            content: DOCKERFILE,
            message: "seed demo app",
        });
        // intentic only WIRES CI/CD here — it commits the Forgejo Actions workflow + repo secrets and registers
        // the Komodo deployment. It does NOT build or deploy. Committing the workflow triggers the Action, which
        // builds the seeded Dockerfile, pushes it to the registry, and tells Komodo to roll it out.
        log("▶ phase 2 — resolve + apply: wire CI/CD + the Komodo deployment (intentic does not build/deploy) …");
        await writeFile(configPath, deployConfig(true));
        await runCli("resolve", "--config", configPath, "--out", artifactPath);
        await runCli("apply", "--artifact", artifactPath, "--maxIterations", "8");
        log(`▶ CI builds + pushes the image and Komodo rolls it out — polling http://127.0.0.1:${appPort} (up to 5 min) …`);
        for (let i = 0; i < 60 && !appDeployed; i++) {
            const hit = (await ssh(`wget -q -T 5 -O- http://127.0.0.1:${appPort} 2>/dev/null || true`)).trim();
            appDeployed = hit.includes(APP_BODY);
            if (!appDeployed) {
                await sleep(5000);
            }
        }
        log(appDeployed ? `✅ app deployed by CI/CD — serving "${APP_BODY}" on the host` : `⚠ app not live yet on :${appPort} (CI/CD may still be running)`);
    } catch (error) {
        log(`⚠ app phase skipped (platform stays up): ${String(error)}`);
    }

    log("");
    log("════════════════════════════════════════════════════════════════════");
    log("  intentic demo is UP and will stay up until you run `pnpm demo:down`");
    log("════════════════════════════════════════════════════════════════════");
    log("  Public (through the Cloudflare tunnel — DNS/edge may take ~1 min):");
    log(`    Forgejo : ${GIT_URL}`);
    log(`    Komodo  : ${KOMODO_URL}`);
    if (appDeployed) {
        log(`    App     : ${APP_URL}`);
    }
    log("  Local (instant, no DNS needed):");
    log(`    Forgejo : http://127.0.0.1:${forgejoPort}`);
    log(`    Komodo  : http://127.0.0.1:${komodoPort}`);
    log("  Admin login (intentic-generated):");
    log(`    user     : ${ADMIN}`);
    log(`    Forgejo pw: ${forgejoPassword}`);
    log(`    Komodo pw : ${komodoPassword}`);
    log(`    (saved in ${join(workspace, "desired-state", ".secrets.json")})`);
    log(`  SSH into the host:  ssh -p ${sshPort} root@127.0.0.1   (key in ${join(workspace, "desired-state", ".env")})`);
    log("  Tear it all down :  pnpm demo:down");
    log("  Note: keep this machine + Docker running; the public URLs share the");
    log("        tunnel name 'intentic-host', so don't run the e2e at the same time.");
    log("════════════════════════════════════════════════════════════════════");
};

interface DemoState {
    readonly zone: string;
    readonly accountId: string;
    readonly apiToken: string;
    readonly workspace?: string;
}

const down = async (): Promise<void> => {
    const state: Partial<DemoState> = await readFile(stateFile, "utf8")
        .then((text) => JSON.parse(text) as DemoState)
        .catch(() => ({}));
    const zoneName = state.zone ?? zone;
    const account = state.accountId ?? accountId;
    const apiToken = state.apiToken ?? (await readToken());

    log(`▶ removing the demo host container (${CONTAINER}) …`);
    await quiet("docker", ["rm", "-f", CONTAINER]);

    log("▶ deleting the Cloudflare tunnel + DNS records …");
    const tunnel = await cloudflareApi.findTunnel({ accountId: account, apiToken, name: TUNNEL }).catch(() => undefined);
    if (tunnel !== undefined) {
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${tunnel.id}/connections`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${apiToken}` },
        }).catch(() => {});
        await cloudflareApi.deleteTunnel({ accountId: account, apiToken, tunnelId: tunnel.id }).catch((error) => log(`  tunnel: ${String(error)}`));
    }
    const cfZone = await cloudflareApi.getZone({ accountId: account, apiToken, zone: zoneName }).catch(() => undefined);
    if (cfZone !== undefined) {
        for (const name of [`git.${zoneName}`, `komodo.${zoneName}`, `app.${zoneName}`]) {
            const record = await cloudflareApi.findDnsRecord({ apiToken, zoneId: cfZone.id, name }).catch(() => undefined);
            if (record !== undefined) {
                await cloudflareApi
                    .deleteDnsRecord({ apiToken, zoneId: cfZone.id, recordId: record.id })
                    .catch((error) => log(`  dns ${name}: ${String(error)}`));
            }
        }
    }

    if (state.workspace !== undefined) {
        await rm(state.workspace, { recursive: true, force: true }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    log("✅ demo torn down — host container, tunnel, and DNS records removed.");
};

const mode = process.argv[2];
if (mode === "up") {
    await up();
} else if (mode === "down") {
    await down();
} else {
    log("usage: demo <up|down>");
    process.exit(1);
}
