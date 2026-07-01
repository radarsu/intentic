import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The identity every daemon-authored commit carries (inventory edits, the neutral-ledger scaffold, the git
// routes). One source of truth so the workspace history reads consistently regardless of which route wrote it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// Runs a git subcommand inside `dir`; injectable so the workspace git ops are unit-testable without a real
// repo (mirrors the CLI's adopt.ts GitRunner seam).
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const defaultGit: GitRunner = (dir, args) => exec("git", ["-C", dir, ...args]);

// Initialize a fresh git repo in `dir` (created if absent). Scaffolds the workspace's neutral ledger (intent +
// desired-state) at first boot without shelling to `intentic init`.
export const gitInit = async (dir: string, git: GitRunner = defaultGit): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await git(dir, ["init", "-q"]);
};

export interface GitStatus {
    readonly branch: string;
    readonly dirty: boolean;
    // Porcelain entries (e.g. " M src/app.ts"), one per changed path. Mutable to match the wire schema
    // (GitStatusSchema) the status route returns directly.
    readonly files: string[];
}

const porcelainFiles = (stdout: string): string[] =>
    stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

export const gitStatus = async (dir: string, git: GitRunner = defaultGit): Promise<GitStatus> => {
    const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const files = porcelainFiles((await git(dir, ["status", "--porcelain"])).stdout);
    return { branch, dirty: files.length > 0, files };
};

// Stage everything and commit; returns false (no commit) when the tree is clean, so the agent can commit
// freely without erroring on a no-op. Credentials never touch this — push auth rides on the remote the
// runner configured when it cloned.
export const gitCommitAll = async (
    dir: string,
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    await git(dir, ["add", "-A"]);
    if (porcelainFiles((await git(dir, ["status", "--porcelain"])).stdout).length === 0) {
        return false;
    }
    await git(dir, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", message]);
    return true;
};

export const gitPush = async (dir: string, branch: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["push", "origin", `HEAD:${branch}`]);
};

// Clone a repo into <parentDir>/<name> (optionally at a branch). Push/pull auth rides on the URL or the
// credentials the host already holds — no token passes through the platform. The caller validates `name`.
export const gitClone = async (parentDir: string, name: string, cloneUrl: string, branch?: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(parentDir, ["clone", ...(branch !== undefined ? ["--branch", branch] : []), cloneUrl, name]);
};

// The repo's tracked files (git ls-files), so the UI can render the source tree without node_modules/build
// noise. Untracked-but-present files are intentionally excluded — they surface through status instead.
export const gitListFiles = async (dir: string, git: GitRunner = defaultGit): Promise<string[]> =>
    (await git(dir, ["ls-files"])).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
