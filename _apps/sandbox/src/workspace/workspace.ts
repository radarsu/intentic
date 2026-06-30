import { join } from "node:path";

// The three repos a project's workspace operates on, by role: the infra intent (deploy.config.ts), the
// resolved desired-state artifact, and the application code. The agent edits all three; app changes drive
// the live preview, intent/desired-state changes flow through the reviewed deploy loop on push.
export type RepoRole = "intent" | "desired-state" | "app";

export const REPO_ROLES: readonly RepoRole[] = ["intent", "desired-state", "app"];

export interface WorkspacePaths {
    readonly root: string;
    readonly repos: Readonly<Record<RepoRole, string>>;
}

// The on-disk layout each repo is cloned into under <root>/<role>. Pure path derivation so the daemon and
// tests all agree on where each repo lives.
export const workspacePaths = (root: string): WorkspacePaths => ({
    root,
    repos: {
        intent: join(root, "intent"),
        "desired-state": join(root, "desired-state"),
        app: join(root, "app"),
    },
});
