import { join } from "node:path";

// The three repos a project's workspace operates on, by role: the infra intent (deploy.config.ts), the
// resolved desired-state artifact, and the application code. The agent edits all three; app changes drive
// the live preview, intent/desired-state changes flow through the reviewed deploy loop on push.
export type RepoRole = "intent" | "desired-state" | "app";

export const REPO_ROLES: readonly RepoRole[] = ["intent", "desired-state", "app"];

export interface WorkspacePaths {
    readonly root: string;
    // All git repos live under <root>/repositories so the <root> itself stays the user's own file space.
    readonly repositories: string;
    readonly repos: Readonly<Record<RepoRole, string>>;
}

// The on-disk layout: every repo lives under <root>/repositories/<role> (keeping <root> free for the user's own
// files). Pure path derivation so the daemon, the CLI, and tests all agree on where each repo lives.
export const workspacePaths = (root: string): WorkspacePaths => {
    const repositories = join(root, "repositories");
    return {
        root,
        repositories,
        repos: {
            intent: join(repositories, "intent"),
            "desired-state": join(repositories, "desired-state"),
            app: join(repositories, "app"),
        },
    };
};
