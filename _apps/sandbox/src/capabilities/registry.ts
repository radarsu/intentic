import type { CapabilityKind } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "./capability.js";
import { cliHandler } from "./handlers/cli.js";
import { devopsHandler } from "./handlers/devops.js";
import { integrationHandler } from "./handlers/integration.js";
import { mcpHandler } from "./handlers/mcp.js";
import { serviceHandler } from "./handlers/service.js";

// Every capability kind's handler. Total over CapabilityKind, so an unhandled kind is a compile error.
export const registry: Record<CapabilityKind, CapabilityHandler> = {
    devops: devopsHandler,
    mcp: mcpHandler,
    service: serviceHandler,
    integration: integrationHandler,
    cli: cliHandler,
};
