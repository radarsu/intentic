import { join } from "node:path";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR } from "../git/git.js";
import { scaffoldDeployConfig } from "../inventory/deploy-config.js";

// The desired-state repo's local-only / secret files, kept out of its PR-managed history (mirrors the CLI init's
// TARGET_GITIGNORE): the user-supplied `.env`, the generated `.secrets.json`, and the `.last-applied.json` prune
// baseline. `resolve` regenerates `.env.example` from the graph; `apply` reads secrets from `.env`.
const TARGET_GITIGNORE = ".env\n.secrets.json\n.last-applied.json\n";
// The intent repo's `pnpm install` (added later, when the user opts to deploy) produces a node_modules/.
const INTENT_GITIGNORE = "node_modules/\n";

// First-boot scaffold of a NEUTRAL ledger: the intent + desired-state git repos with an empty deploy.config.ts
// (only the managed `// <intentic>` region) and NO app repo — the sandbox is reachable and its inventory /
// source-control have something to read, but nothing is provisioned. No host, no app, no `intentic init`.
// Provisioning readiness (the intent repo's @intentic deps + install, and an app) is added later by the
// "Deploy on this machine" flow. Idempotent via the caller's `existsSync(intent)` gate.
export const scaffoldNeutralLedger = async (services: Services): Promise<void> => {
    const intent = services.workspace.repos.intent;
    const desiredState = services.workspace.repos["desired-state"];

    await services.git.init(intent);
    await services.files.write(join(intent, "deploy.config.ts"), scaffoldDeployConfig([]));
    await services.files.write(join(intent, ".gitignore"), INTENT_GITIGNORE);
    await services.git.commitAll(intent, "chore(intentic): scaffold neutral ledger", AGENT_GIT_AUTHOR);

    await services.git.init(desiredState);
    await services.files.write(join(desiredState, ".gitignore"), TARGET_GITIGNORE);
    await services.git.commitAll(desiredState, "chore(intentic): scaffold desired-state", AGENT_GIT_AUTHOR);
};
