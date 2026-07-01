import { agentContract } from "./contracts/agent.contract.js";
import { capabilitiesContract } from "./contracts/capabilities.contract.js";
import { claudeContract } from "./contracts/claude.contract.js";
import { gitContract } from "./contracts/git.contract.js";
import { intenticContract } from "./contracts/intentic.contract.js";
import { inventoryContract } from "./contracts/inventory.contract.js";
import { sessionsContract } from "./contracts/sessions.contract.js";
import { systemContract } from "./contracts/system.contract.js";
import { workspaceContract } from "./contracts/workspace.contract.js";

export { agentContract } from "./contracts/agent.contract.js";
export { capabilitiesContract } from "./contracts/capabilities.contract.js";
export { claudeContract } from "./contracts/claude.contract.js";
export { gitContract } from "./contracts/git.contract.js";
export { intenticContract } from "./contracts/intentic.contract.js";
export { inventoryContract } from "./contracts/inventory.contract.js";
export { sessionsContract } from "./contracts/sessions.contract.js";
export { systemContract } from "./contracts/system.contract.js";
export { workspaceContract } from "./contracts/workspace.contract.js";
export * from "./events.js";
export * from "./schemas.js";

// The aggregated contract — implemented on the server by the per-domain route factories and consumed by the
// browser's typed oRPC client (ContractRouterClient<typeof sandboxContract>). The wire paths it declares are
// mounted at the sandbox root, so /health and /workspace/raw (plain Hono routes) sit alongside it.
export const sandboxContract = {
    agent: agentContract,
    capabilities: capabilitiesContract,
    claude: claudeContract,
    sessions: sessionsContract,
    intentic: intenticContract,
    git: gitContract,
    workspace: workspaceContract,
    inventory: inventoryContract,
    system: systemContract,
};
