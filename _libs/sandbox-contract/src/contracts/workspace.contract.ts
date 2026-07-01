import { oc } from "@orpc/contract";
import {
    AppScaffoldSchema,
    CloneRepoSchema,
    CloneResultSchema,
    OkSchema,
    ReposListSchema,
    WorkspaceDirSchema,
    WorkspaceFileQuerySchema,
    WorkspaceFileSchema,
    WorkspaceMoveSchema,
    WorkspaceTreeSchema,
} from "../schemas.js";

// The full /work view + extra-repo cloning. The binary preview (/workspace/raw) is intentionally NOT here — it
// stays a plain Hono route serving raw bytes with a Content-Type header (oRPC's request/response shape doesn't
// fit a streamed binary body). External MCP tools moved to the unified capabilities manifest (mcp kind).
export const workspaceContract = {
    tree: oc.route({ method: "GET", path: "/workspace/tree" }).output(WorkspaceTreeSchema),
    file: oc.route({ method: "GET", path: "/workspace/file" }).input(WorkspaceFileQuerySchema).output(WorkspaceFileSchema),
    // Direct file management the browser drives against the /work tree (byte writes go through POST
    // /workspace/upload). oRPC's OpenAPI codec reads non-GET input from the JSON body, so delete sends {path}
    // in the body too (not the query) — same as the POST routes.
    mkdir: oc.route({ method: "POST", path: "/workspace/dir" }).input(WorkspaceDirSchema).output(OkSchema),
    delete: oc.route({ method: "DELETE", path: "/workspace/entry" }).input(WorkspaceFileQuerySchema).output(OkSchema),
    move: oc.route({ method: "POST", path: "/workspace/move" }).input(WorkspaceMoveSchema).output(OkSchema),
    copy: oc.route({ method: "POST", path: "/workspace/copy" }).input(WorkspaceMoveSchema).output(OkSchema),
    repos: oc.route({ method: "GET", path: "/workspace/repos" }).output(ReposListSchema),
    addRepo: oc.route({ method: "POST", path: "/workspace/repos" }).input(CloneRepoSchema).output(CloneResultSchema),
    // Scaffold (or adopt) the deployable app at /work/app — the fixed app role, distinct from addRepo's sibling repos.
    addApp: oc.route({ method: "POST", path: "/workspace/app" }).input(AppScaffoldSchema).output(OkSchema),
};
