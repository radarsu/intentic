import { createAgentRoutes } from "./agent/agent.routes.js";
import { createAutomationsRoutes } from "./automations/automations.routes.js";
import { createCapabilitiesRoutes } from "./capabilities/capabilities.routes.js";
import { createClaudeRoutes } from "./claude/claude.routes.js";
import type { Services } from "./composition.js";
import { createGitRoutes } from "./git/git.routes.js";
import { createIntenticRoutes } from "./intentic/intentic.routes.js";
import { createInventoryRoutes } from "./inventory/inventory.routes.js";
import { createSecretsRoutes } from "./secrets/secrets.routes.js";
import { createSessionsRoutes } from "./sessions/sessions.routes.js";
import { createSystemRoutes } from "./system/system.routes.js";
import { createWorkspaceRoutes } from "./workspace/workspace.routes.js";

// The implemented oRPC router — the per-domain route factories assembled into the sandboxContract shape. The
// OpenAPIHandler in app.ts serves it.
export const createRouter = (services: Services) => ({
    agent: createAgentRoutes(services),
    automations: createAutomationsRoutes(services),
    capabilities: createCapabilitiesRoutes(services),
    claude: createClaudeRoutes(services),
    sessions: createSessionsRoutes(services),
    intentic: createIntenticRoutes(services),
    git: createGitRoutes(services),
    workspace: createWorkspaceRoutes(services),
    inventory: createInventoryRoutes(services),
    secrets: createSecretsRoutes(services),
    system: createSystemRoutes(services),
});
