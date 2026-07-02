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
import { resolveWithin } from "./workspace-files.js";
import { isDeniedWorkspacePath } from "./workspace-tree.js";

// The full /work view + extra-repo cloning. The binary /workspace/raw preview is a plain Hono route in app.ts
// (a streamed binary body doesn't fit oRPC). External MCP tools moved to the unified capabilities manifest.
export const createWorkspaceRoutes = (services: Services) => {
    const i = implement(workspaceContract).$context<OrpcContext>();
    // Resolve a root-relative path to an absolute one inside /work, applying the same two guards the read routes
    // use: a `../`/absolute escape is BAD_REQUEST, a `.git`/secret path is NOT_FOUND (never served, never written).
    const contained = (relPath: string): string => {
        const target = resolveWithin(services.workspace.root, relPath);
        if (target === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
        }
        if (isDeniedWorkspacePath(relPath)) {
            throw new ORPCError("NOT_FOUND", { message: "not found" });
        }
        return target;
    };
    return {
        tree: i.tree.handler(() => services.workspaceTree(services.workspace.root)),
        // Live change stream (SSE): fan events off the shared watcher until the client disconnects. Reconnects
        // reconcile via /workspace/tree, so a dropped connection only means a gap the agent's next walk closes.
        watch: i.watch.handler(async function* () {
            yield* services.workspaceWatch();
        }),
        file: i.file.handler(async ({ input }) => {
            const content = await services.files.read(contained(input.path));
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        // Direct file management over /work (byte writes go through POST /workspace/upload). Both endpoints of a
        // move/copy are guarded, so neither source nor target can escape or touch a secret/`.git` path.
        mkdir: i.mkdir.handler(async ({ input }) => {
            await services.files.mkdir(contained(input.path));
            return { ok: true } as const;
        }),
        delete: i.delete.handler(async ({ input }) => {
            await services.files.remove(contained(input.path));
            return { ok: true } as const;
        }),
        move: i.move.handler(async ({ input }) => {
            await services.files.move(contained(input.from), contained(input.to));
            return { ok: true } as const;
        }),
        copy: i.copy.handler(async ({ input }) => {
            await services.files.copy(contained(input.from), contained(input.to));
            return { ok: true } as const;
        }),
        repos: i.repos.handler(async () => ({ repos: await listRepos(services.workspace.repositories) })),
        addRepo: i.addRepo.handler(async ({ input }) => {
            if (!isValidRepoName(input.name)) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid or reserved repo name" });
            }
            if ((await listRepos(services.workspace.repositories)).includes(input.name)) {
                throw new ORPCError("CONFLICT", { message: `a repo named "${input.name}" already exists` });
            }
            // The repositories/ dir may not exist yet on a fresh sandbox; git clone needs its parent present.
            await services.files.mkdir(services.workspace.repositories);
            await services.git.clone(services.workspace.repositories, input.name, input.cloneUrl, input.branch);
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
            const args = ["add-app", "--dir", services.workspace.repositories, ...(input.cloneUrl !== undefined ? ["--app", input.cloneUrl] : [])];
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
    };
};
