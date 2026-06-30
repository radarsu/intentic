import { agentContract } from "./agent.contract.js";
import { claudeContract } from "./claude.contract.js";
import { gitContract } from "./git.contract.js";
import { intenticContract } from "./intentic.contract.js";
import { inventoryContract } from "./inventory.contract.js";
import { sessionsContract } from "./sessions.contract.js";
import { systemContract } from "./system.contract.js";
import { workspaceContract } from "./workspace.contract.js";

export { agentContract } from "./agent.contract.js";
export { claudeContract } from "./claude.contract.js";
export * from "./events.js";
export { gitContract } from "./git.contract.js";
export { intenticContract } from "./intentic.contract.js";
export { inventoryContract } from "./inventory.contract.js";
export * from "./schemas.js";
export { sessionsContract } from "./sessions.contract.js";
export { systemContract } from "./system.contract.js";
export { workspaceContract } from "./workspace.contract.js";

// The aggregated contract — implemented on the server by the per-domain route factories and consumed by the
// browser's typed oRPC client (ContractRouterClient<typeof sandboxContract>). The wire paths it declares are
// mounted at the sandbox root, so /health and /workspace/raw (plain Hono routes) sit alongside it.
export const sandboxContract = {
    agent: agentContract,
    claude: claudeContract,
    sessions: sessionsContract,
    intentic: intenticContract,
    git: gitContract,
    workspace: workspaceContract,
    inventory: inventoryContract,
    system: systemContract,
};
