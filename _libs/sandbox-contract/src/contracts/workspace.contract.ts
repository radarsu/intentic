import { oc } from "@orpc/contract";
import {
    CloneRepoSchema,
    CloneResultSchema,
    OkSchema,
    ReposListSchema,
    ToolAddResultSchema,
    ToolInputSchema,
    ToolNameParamSchema,
    ToolsListSchema,
    WorkspaceFileQuerySchema,
    WorkspaceFileSchema,
    WorkspaceTreeSchema,
} from "../schemas.js";

// The full /work view + extra-repo cloning + the sandbox-owned external MCP tools store. The binary preview
// (/workspace/raw) is intentionally NOT here — it stays a plain Hono route serving raw bytes with a
// Content-Type header (oRPC's request/response shape doesn't fit a streamed binary body).
export const workspaceContract = {
    tree: oc.route({ method: "GET", path: "/workspace/tree" }).output(WorkspaceTreeSchema),
    file: oc.route({ method: "GET", path: "/workspace/file" }).input(WorkspaceFileQuerySchema).output(WorkspaceFileSchema),
    repos: oc.route({ method: "GET", path: "/workspace/repos" }).output(ReposListSchema),
    addRepo: oc.route({ method: "POST", path: "/workspace/repos" }).input(CloneRepoSchema).output(CloneResultSchema),
    tools: oc.route({ method: "GET", path: "/workspace/tools" }).output(ToolsListSchema),
    addTool: oc.route({ method: "POST", path: "/workspace/tools" }).input(ToolInputSchema).output(ToolAddResultSchema),
    removeTool: oc.route({ method: "DELETE", path: "/workspace/tools/{name}" }).input(ToolNameParamSchema).output(OkSchema),
};
