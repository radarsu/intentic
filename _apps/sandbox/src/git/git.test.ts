import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type GitRunner, gitClone, gitCommitAll, gitStatus } from "./git.js";

// A GitRunner that returns canned stdout per joined-args key and records every invocation.
const recordingGit = (responses: Readonly<Record<string, string>>) => {
    const calls: string[][] = [];
    const git: GitRunner = async (dir, args) => {
        calls.push([dir, ...args]);
        return { stdout: responses[args.join(" ")] ?? "", stderr: "" };
    };
    return { git, calls };
};

test("gitStatus reports branch, dirtiness, and porcelain files", async () => {
    const { git } = recordingGit({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": " M src/app.ts\n?? new.ts\n" });
    expect(await gitStatus("/work/app", git)).toEqual({ branch: "main", dirty: true, files: ["M src/app.ts", "?? new.ts"] });
});

test("gitStatus on a clean tree is not dirty", async () => {
    const { git } = recordingGit({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": "\n" });
    expect(await gitStatus("/work/app", git)).toEqual({ branch: "main", dirty: false, files: [] });
});

test("gitCommitAll stages, commits with the author identity, and reports a commit was made", async () => {
    const { git, calls } = recordingGit({ "status --porcelain": " M src/app.ts\n" });
    const committed = await gitCommitAll("/work/app", "agent edit", { name: "intentic", email: "agent@intentic.dev" }, git);
    expect(committed).toBe(true);
    expect(calls).toContainEqual(["/work/app", "add", "-A"]);
    expect(calls).toContainEqual(["/work/app", "-c", "user.name=intentic", "-c", "user.email=agent@intentic.dev", "commit", "-m", "agent edit"]);
});

test("gitClone forwards the auth header, branch, and separate git dir flags, and creates the git dir's parent", async () => {
    const historyRoot = await mkdtemp(join(tmpdir(), "intentic-git-test-"));
    await rm(historyRoot, { recursive: true });
    const separateGitDir = join(historyRoot, "gits", "extra");
    const { git, calls } = recordingGit({});
    await gitClone(
        "/work/repositories",
        "extra",
        "https://example.com/extra.git",
        { branch: "main", authHeader: "Authorization: Basic abc", separateGitDir },
        git,
    );
    expect(calls).toEqual([
        [
            "/work/repositories",
            "-c",
            "http.extraheader=Authorization: Basic abc",
            "clone",
            "--branch",
            "main",
            `--separate-git-dir=${separateGitDir}`,
            "https://example.com/extra.git",
            "extra",
        ],
    ]);
    await expect(access(join(historyRoot, "gits"))).resolves.toBeUndefined();
    await rm(historyRoot, { recursive: true });
});

test("gitClone with no options is a bare clone", async () => {
    const { git, calls } = recordingGit({});
    await gitClone("/work/repositories", "extra", "https://example.com/extra.git", undefined, git);
    expect(calls).toEqual([["/work/repositories", "clone", "https://example.com/extra.git", "extra"]]);
});

test("gitCommitAll is a no-op (returns false, never commits) on a clean tree", async () => {
    const { git, calls } = recordingGit({ "status --porcelain": "" });
    const committed = await gitCommitAll("/work/app", "agent edit", { name: "intentic", email: "agent@intentic.dev" }, git);
    expect(committed).toBe(false);
    expect(calls.some((call) => call.includes("commit"))).toBe(false);
});
