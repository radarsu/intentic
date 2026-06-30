import { createAgentRoutes } from "./agent.routes.js";
import { createClaudeRoutes } from "./claude.routes.js";
import type { Services } from "./composition.js";
import { createGitRoutes } from "./git.routes.js";
import { createIntenticRoutes } from "./intentic.routes.js";
import { createInventoryRoutes } from "./inventory.routes.js";
import { createSessionsRoutes } from "./sessions.routes.js";
import { createSystemRoutes } from "./system.routes.js";
import { createWorkspaceRoutes } from "./workspace.routes.js";

// The implemented oRPC router — the per-domain route factories assembled into the sandboxContract shape. The
// OpenAPIHandler in app.ts serves it.
export const createRouter = (services: Services) => ({
    agent: createAgentRoutes(services),
    claude: createClaudeRoutes(services),
    sessions: createSessionsRoutes(services),
    intentic: createIntenticRoutes(services),
    git: createGitRoutes(services),
    workspace: createWorkspaceRoutes(services),
    inventory: createInventoryRoutes(services),
    system: createSystemRoutes(services),
});
