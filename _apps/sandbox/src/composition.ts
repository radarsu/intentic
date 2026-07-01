import { join } from "node:path";
import type { AgentEvent, IntenticLine, SelfHost, WorkspaceTree } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { type AgentRequest, runAgent } from "./agent/agent.js";
import { type CapabilitiesStore, fileCapabilitiesStore } from "./capabilities/capabilities-store.js";
import { createAuthorizer, createGoogleVerifier, fileOwnerStore } from "./auth/auth.js";
import { type ClaudeStore, fileClaudeStore } from "./claude/claude-credentials.js";
import type { Config } from "./env.config.js";
import { type GitStatus, gitClone, gitCommitAll, gitInit, gitListFiles, gitPush, gitStatus } from "./git/git.js";
import { type IntenticRun, runIntentic } from "./intentic/intentic-runner.js";
import { listWorkspaceSessions, readWorkspaceSession, type SessionSummary, type SessionTranscriptMessage } from "./sessions/sessions.js";
import { createDevServer, type DevServer } from "./system/dev-server.js";
import { type AgentTool, internalTools } from "./workspace/tools.js";
import { type WorkspacePaths, workspacePaths } from "./workspace/workspace.js";
import {
    copyWorkspacePath,
    makeWorkspaceDir,
    moveWorkspacePath,
    readWorkspaceFile,
    readWorkspaceFileBytes,
    removeWorkspacePath,
    statWorkspaceFileSize,
    writeWorkspaceFile,
} from "./workspace/workspace-files.js";
import { walkWorkspaceTree } from "./workspace/workspace-tree.js";

// The daemon's collaborators, wired once at boot and handed to the route factories — the injection seam the
// route tests build fakes against (the equivalent of the old createDaemon `deps` object). Stateful members
// (devServer, the agent/intentic process runners, the credential/tool stores) live here; the in-memory
// plan/question bridge stays a module singleton in agent-requests.ts (the agent routes call it directly).
export interface Services {
    readonly config: Config;
    readonly logger: Logger;
    readonly workspace: WorkspacePaths;
    readonly devServer: DevServer;
    // Present only when this sandbox was started with a wired self-host deploy target (SELF_HOST_USER + a key).
    readonly selfHost: SelfHost | undefined;
    // This sandbox's identity for the platform's Connections card; undefined ⇒ /info returns {} (loopback/test).
    readonly info: { readonly name: string; readonly image: string } | undefined;
    // Intent-declared internal MCP tools (constant for the sandbox), merged with mcp-kind capabilities each turn.
    readonly tools: readonly AgentTool[];
    // The unified capability manifest (.intentic/capabilities.json) — DevOps/mcp/service/integration.
    readonly capabilities: CapabilitiesStore;
    readonly claudeStore: ClaudeStore;
    readonly agent: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
    readonly intentic: (run: IntenticRun) => AsyncGenerator<IntenticLine>;
    readonly git: {
        readonly init: (dir: string) => Promise<void>;
        readonly status: (dir: string) => Promise<GitStatus>;
        readonly listFiles: (dir: string) => Promise<string[]>;
        readonly commitAll: (dir: string, message: string, author: { name: string; email: string }) => Promise<boolean>;
        readonly push: (dir: string, branch: string) => Promise<void>;
        readonly clone: (parentDir: string, name: string, cloneUrl: string, branch?: string) => Promise<void>;
    };
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        readonly write: (absPath: string, content: string | Uint8Array) => Promise<void>;
        readonly readBytes: (absPath: string) => Promise<Buffer | undefined>;
        readonly size: (absPath: string) => Promise<number | undefined>;
        readonly mkdir: (absPath: string) => Promise<void>;
        readonly remove: (absPath: string) => Promise<void>;
        readonly move: (fromAbs: string, toAbs: string) => Promise<void>;
        readonly copy: (fromAbs: string, toAbs: string) => Promise<void>;
    };
    readonly workspaceTree: (root: string) => Promise<WorkspaceTree>;
    readonly sessions: {
        readonly list: (dir: string) => Promise<SessionSummary[]>;
        readonly read: (dir: string, id: string) => Promise<SessionTranscriptMessage[]>;
    };
    // When set, the daemon is exposed directly and verifies the owner's Google ID token on every route but
    // /health; CORS is emitted for `allowOrigin`. Undefined ⇒ loopback mode (tests / host-internal preview).
    readonly auth:
        { readonly authorize: (bearer: string, firstBind: string | undefined) => Promise<void>; readonly allowOrigin?: string } | undefined;
}

// Build the production services from config (env). The agent/intentic/git/files/sessions/tree members are the
// real module functions referenced directly (their injectable last arg defaults to the real subprocess/fs).
export const createServices = (config: Config, logger: Logger): Services => {
    const workspace = workspacePaths(config.workspaceRoot);
    const selfHost: SelfHost | undefined =
        config.selfHost.user !== "" && config.hostSshKey !== ""
            ? { user: config.selfHost.user, address: config.selfHost.address, port: 22, via: config.selfHost.via }
            : undefined;
    const info = config.sandbox.name !== "" && config.sandbox.image !== "" ? { name: config.sandbox.name, image: config.sandbox.image } : undefined;
    const auth =
        config.google.clientId !== ""
            ? {
                  authorize: createAuthorizer({
                      verify: createGoogleVerifier(config.google.clientId),
                      owner: fileOwnerStore(join(workspace.root, ".intentic", "owner.json")),
                      ...(config.connectToken !== "" ? { connectToken: config.connectToken } : {}),
                  }).authorize,
                  ...(config.webOrigin !== "" ? { allowOrigin: config.webOrigin } : {}),
              }
            : undefined;

    return {
        config,
        logger,
        workspace,
        devServer: createDevServer(),
        selfHost,
        info,
        tools: internalTools(config.intenticAgentTools),
        capabilities: fileCapabilitiesStore(join(workspace.root, ".intentic", "capabilities.json")),
        claudeStore: fileClaudeStore(join(workspace.root, ".intentic", "claude.json")),
        agent: runAgent,
        intentic: runIntentic,
        git: { init: gitInit, status: gitStatus, listFiles: gitListFiles, commitAll: gitCommitAll, push: gitPush, clone: gitClone },
        files: {
            read: readWorkspaceFile,
            write: writeWorkspaceFile,
            readBytes: readWorkspaceFileBytes,
            size: statWorkspaceFileSize,
            mkdir: makeWorkspaceDir,
            remove: removeWorkspacePath,
            move: moveWorkspacePath,
            copy: copyWorkspacePath,
        },
        workspaceTree: walkWorkspaceTree,
        sessions: { list: listWorkspaceSessions, read: readWorkspaceSession },
        auth,
    };
};
