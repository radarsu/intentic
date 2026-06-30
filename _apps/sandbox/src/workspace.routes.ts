import { workspaceContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "./composition.js";
import type { OrpcContext } from "./context.js";
import { isValidRepoName, listRepos } from "./repos.js";
import { isValidToolName } from "./tools.js";
import { resolveWithin } from "./workspace-files.js";
import { isDeniedWorkspacePath } from "./workspace-tree.js";

// The full /work view + extra-repo cloning + the sandbox-owned external MCP tools store. The binary
// /workspace/raw preview is a plain Hono route in app.ts (a streamed binary body doesn't fit oRPC).
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    return {
        tree: i.tree.handler(() => services.workspaceTree(services.workspace.root)),
        file: i.file.handler(async ({ input }) => {
            const target = resolveWithin(services.workspace.root, input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            if (isDeniedWorkspacePath(input.path)) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            const content = await services.files.read(target);
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        repos: i.repos.handler(async () => ({ repos: await listRepos(services.workspace.root) })),
        addRepo: i.addRepo.handler(async ({ input }) => {
            if (!isValidRepoName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid or reserved repo name" });
            }
            if ((await listRepos(services.workspace.root)).includes(input.name)) {
                throw new ORPCError("CONFLICT", { message: `a repo named "${input.name}" already exists` });
            }
            await services.git.clone(services.workspace.root, input.name, input.cloneUrl, input.branch);
            return { name: input.name, path: input.name };
        }),
        // GET never returns the token (it stays in the sandbox); the list only reports presence.
        tools: i.tools.handler(async () => ({
            tools: (await services.externalTools.list()).map((tool) => ({ name: tool.name, url: tool.url, hasToken: tool.token !== undefined })),
        })),
        addTool: i.addTool.handler(async ({ input }) => {
            if (!isValidToolName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid tool name (use letters, digits, '-' or '_'; must start alphanumeric)" });
            }
            // Upsert by name: re-posting the same name edits its url/token.
            await services.externalTools.add({ name: input.name, url: input.url, ...(input.token !== undefined ? { token: input.token } : {}) });
            return { name: input.name };
        }),
        removeTool: i.removeTool.handler(async ({ input }) => {
            if (!(await services.externalTools.remove(input.name))) {
                throw new ORPCError("NOT_FOUND", { message: "no tool with that name" });
            }
            return { ok: true } as const;
        }),
    };
};
