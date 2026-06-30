import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROLES } from "./workspace.js";

// Extra repositories the user clones into /work (beyond the three fixed roles) so the agent can build and edit
// more than one app's source in a sandbox. They live as sibling dirs under /work and surface in the workspace
// tree like everything else; the daemon owns the clone (the platform holds no git token).

const RESERVED = new Set<string>(REPO_ROLES);
// A safe sibling directory name: starts alphanumeric, no separators or `..`, and not one of the three roles.
const REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const isValidRepoName = (name: string): boolean => REPO_NAME.test(name) && !name.includes("..") && !RESERVED.has(name);

const hasGitDir = async (dir: string): Promise<boolean> => {
    try {
        await access(join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
};

// Every extra repo cloned into /work: a directory with a .git that isn't one of the three fixed roles.
export const listRepos = async (root: string): Promise<string[]> => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
        return [];
    }
    const repos: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || RESERVED.has(entry.name) || !isValidRepoName(entry.name)) {
            continue;
        }
        if (await hasGitDir(join(root, entry.name))) {
            repos.push(entry.name);
        }
    }
    return repos.sort();
};
