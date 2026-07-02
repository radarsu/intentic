import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { binDir } from "./config.js";
import { IGNORES, sanitizeId } from "./ssh.js";

// Pinned tool versions. cloudflared matches the sandbox image's pin so both ends speak the same tunnel protocol.
const MUTAGEN_VERSION = "0.18.1";
const CLOUDFLARED_VERSION = "2026.6.1";

// The Mutagen session name (letters/digits/dashes) so `mutagen sync {list,pause,resume,terminate}` can target it.
export const sessionName = (sandboxId: string): string => `intentic-${sanitizeId(sandboxId)}`;

// `mutagen sync create` args: two-way-safe (flags conflicts rather than clobber), our ignore set, and
// neighboring staging on the remote so a huge file stages on the same filesystem as /work (atomic rename, no
// cross-fs 2× copy). local first, then user@alias:/work.
export const mutagenCreateArgs = (args: {
    readonly name: string;
    readonly localDir: string;
    readonly alias: string;
    readonly remoteDir: string;
}): string[] => [
    "sync",
    "create",
    "--name",
    args.name,
    "--ignore-vcs",
    ...IGNORES.flatMap((pattern) => ["--ignore", pattern]),
    "--stage-mode-beta",
    "neighboring",
    args.localDir,
    `${args.alias}:${args.remoteDir}`,
];

const osToken = (): "linux" | "darwin" => {
    if (process.platform === "linux" || process.platform === "darwin") {
        return process.platform;
    }
    throw new Error(`auto-download isn't supported on ${process.platform} — install mutagen and cloudflared manually, then re-run.`);
};

const archToken = (): "amd64" | "arm64" => {
    if (process.arch === "x64") {
        return "amd64";
    }
    if (process.arch === "arm64") {
        return "arm64";
    }
    throw new Error(`unsupported CPU arch ${process.arch} — install mutagen and cloudflared manually, then re-run.`);
};

const onPath = (binary: string, versionArgs: string[]): boolean => {
    const result = spawnSync(binary, versionArgs, { stdio: "ignore" });
    return result.error === undefined && result.status === 0;
};

const download = async (url: string, dest: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download failed (${response.status}): ${url}`);
    }
    await mkdir(binDir, { recursive: true });
    await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
};

// Resolve cloudflared: on PATH, else download the single static binary to ~/.intentic/sync/bin.
export const ensureCloudflared = async (): Promise<string> => {
    if (onPath("cloudflared", ["--version"])) {
        return "cloudflared";
    }
    const dest = join(binDir, "cloudflared");
    await download(
        `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-${osToken()}-${archToken()}`,
        dest,
    );
    await chmod(dest, 0o755);
    return dest;
};

// Resolve mutagen: on PATH, else download+extract the release tarball (binary + agent bundle side by side, as
// Mutagen requires) to ~/.intentic/sync/bin using the system `tar`.
export const ensureMutagen = async (): Promise<string> => {
    if (onPath("mutagen", ["version"])) {
        return "mutagen";
    }
    const dest = join(binDir, "mutagen");
    const tarball = join(binDir, "mutagen.tar.gz");
    await download(
        `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${osToken()}_${archToken()}_v${MUTAGEN_VERSION}.tar.gz`,
        tarball,
    );
    const extract = spawnSync("tar", ["-xzf", tarball, "-C", binDir], { stdio: "inherit" });
    if (extract.status !== 0) {
        throw new Error("failed to extract the mutagen release (is `tar` installed?)");
    }
    await chmod(dest, 0o755);
    return dest;
};

// Run a mutagen subcommand, inheriting stdio; throw on failure so the CLI surfaces it.
export const runMutagen = (mutagen: string, args: string[]): SpawnSyncReturns<Buffer> => {
    const result = spawnSync(mutagen, args, { stdio: "inherit" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`mutagen ${args[0] ?? ""} exited with code ${result.status}`);
    }
    return result;
};
