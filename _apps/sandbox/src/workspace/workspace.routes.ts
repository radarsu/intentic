import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { workspaceContract } from "@intentic/sandbox-contract";
import { insertAppStanza, readManagedRegion } from "@intentic/scaffold";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { createConfigStore } from "../inventory/config-store.js";
import { zoneFromPublicUrl } from "../system/zone.js";
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
        // Scaffold (or adopt) the deployable app at /work/app. The neutral workspace has none until the user opts
        // to build/deploy one. Then, when this sandbox is a deploy target (self + cf declared), declare the app
        // for deployment (app.<zone>) and bring the live preview up now (no restart).
        addApp: i.addApp.handler(async ({ input }) => {
            const appDir = services.workspace.repos.app;
            if (existsSync(appDir)) {
                throw new ORPCError("CONFLICT", { message: "an app already exists" });
            }
            const args = ["add-app", "--dir", services.workspace.root, ...(input.cloneUrl !== undefined ? ["--app", input.cloneUrl] : [])];
            if (spawnSync("intentic", args, { stdio: "inherit" }).status !== 0) {
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "failed to scaffold the app" });
            }
            const config = createConfigStore(services);
            const content = await config.read();
            const entries = readManagedRegion(content);
            const hasSelf = entries.some((entry) => entry.kind === "backend" && entry.provider === "host" && entry.name === "self");
            const hasCf = entries.some((entry) => entry.kind === "backend" && entry.provider === "cloudflare" && entry.name === "cf");
            const zone = services.config.zone !== "" ? services.config.zone : zoneFromPublicUrl(services.config.sandbox.publicUrl);
            if (hasSelf && hasCf && zone !== undefined && zone !== "") {
                const next = insertAppStanza(content, zone);
                if (next !== content) {
                    await config.write(next, "chore(intentic): declare app for deployment");
                }
            }
            if (services.config.dev.command !== "" && services.config.dev.port !== "") {
                services.devServer.start({ command: services.config.dev.command.split(" "), cwd: appDir, port: Number(services.config.dev.port) });
            }
            return { ok: true } as const;
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
