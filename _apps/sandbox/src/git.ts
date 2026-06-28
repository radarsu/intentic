import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Runs a git subcommand inside `dir`; injectable so the workspace git ops are unit-testable without a real
// repo (mirrors the CLI's adopt.ts GitRunner seam).
export type GitRunner = (dir: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
const defaultGit: GitRunner = (dir, args) => exec("git", ["-C", dir, ...args]);

export interface GitStatus {
    readonly branch: string;
    readonly dirty: boolean;
    // Porcelain entries (e.g. " M src/app.ts"), one per changed path.
    readonly files: readonly string[];
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
