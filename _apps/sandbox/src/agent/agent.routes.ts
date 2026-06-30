import { type AgentEvent, type AgentTurn, agentContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { ensureFreshToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import type { AgentRequest } from "./agent.js";
import { resolvePlanDecision, resolveQuestionAnswer } from "./agent-requests.js";

// Run one agent turn, streaming typed AgentEvents. The Claude token is the sandbox's own credential (resolved
// + refreshed here), never held by the platform; undefined falls back to the container env. A turn with no
// stored account and no container-env fallback surfaces an actionable error rather than an opaque CLI failure.
async function* streamAgent(services: Services, input: AgentTurn, signal: AbortSignal | undefined): AsyncGenerator<AgentEvent> {
    let oauthToken: string | undefined;
    try {
        oauthToken = await ensureFreshToken(services.claudeStore);
    } catch (error) {
        yield { kind: "error", message: error instanceof Error ? error.message : "claude credentials unavailable" };
        yield { kind: "done" };
        return;
    }
    if (oauthToken === undefined && services.config.claudeCodeOauthToken === "" && services.config.anthropicApiKey === "") {
        yield { kind: "error", message: "No Claude account connected — connect it in Setup before chatting." };
        yield { kind: "done" };
        return;
    }
    // Internal (intent-declared, from env) tools first, then external (the sandbox's own store) — a same-named
    // external tool overrides, matching mcpServersOf's last-wins merge.
    const tools = [...services.tools, ...(await services.externalTools.list())];
    const request: AgentRequest = {
        prompt: input.prompt,
        cwd: services.workspace.root,
        signal: signal ?? new AbortController().signal,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(oauthToken !== undefined ? { oauthToken } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.plan !== undefined ? { plan: input.plan } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(tools.length > 0 ? { tools } : {}),
    };
    yield* services.agent(request);
}

export const createAgentRoutes = (services: Services) => {
    const i = implement(agentContract).$context<OrpcContext>();
    return {
        run: i.run.handler(({ input, signal }) => streamAgent(services, input, signal)),
        // Resolve a turn paused on an ExitPlanMode approval / interactive question; NOT_FOUND when nothing is
        // waiting on that id (already answered, or the turn ended).
        decision: i.decision.handler(({ input }) => {
            const resolved = resolvePlanDecision(input.decisionId, {
                approve: input.approve,
                ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
            });
            if (!resolved) {
                throw new ORPCError("NOT_FOUND", { message: "no pending plan for that decision" });
            }
            return { ok: true } as const;
        }),
        answer: i.answer.handler(({ input }) => {
            const resolved = resolveQuestionAnswer(
                input.requestId,
                input.cancelled === true ? { cancelled: true } : { answers: input.answers ?? {} },
            );
            if (!resolved) {
                throw new ORPCError("NOT_FOUND", { message: "no pending question for that request" });
            }
            return { ok: true } as const;
        }),
    };
};
