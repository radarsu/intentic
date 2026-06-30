import { gitContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "./composition.js";
import type { OrpcContext } from "./context.js";
import { REPO_ROLES, type RepoRole } from "./workspace.js";
import { resolveWithin } from "./workspace-files.js";

const COMMIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// Per-repo git ops over the three workspace repos. An unknown {repo} is NOT_FOUND; a path that escapes the
// repo dir is BAD_REQUEST; a missing file is NOT_FOUND.
export const createGitRoutes = (services: Services) => {
    const i = implement(gitContract).$context<OrpcContext>();
    const repoDir = (repo: string): string => {
        if (!(REPO_ROLES as readonly string[]).includes(repo)) {
            throw new ORPCError("NOT_FOUND", { message: "unknown repo" });
        }
        return services.workspace.repos[repo as RepoRole];
    };
    return {
        status: i.status.handler(({ input }) => services.git.status(repoDir(input.repo))),
        commit: i.commit.handler(async ({ input }) => ({
            committed: await services.git.commitAll(repoDir(input.repo), input.message, COMMIT_AUTHOR),
        })),
        push: i.push.handler(async ({ input }) => {
            await services.git.push(repoDir(input.repo), input.branch);
            return { ok: true } as const;
        }),
        files: i.files.handler(async ({ input }) => ({ files: await services.git.listFiles(repoDir(input.repo)) })),
        readFile: i.readFile.handler(async ({ input }) => {
            const target = resolveWithin(repoDir(input.repo), input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            const content = await services.files.read(target);
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        writeFile: i.writeFile.handler(async ({ input }) => {
            const target = resolveWithin(repoDir(input.repo), input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            await services.files.write(target, input.content);
            return { ok: true } as const;
        }),
    };
};
