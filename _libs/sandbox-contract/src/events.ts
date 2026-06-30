import { z } from "zod";

// The wire shapes streamed from the daemon's event-iterator procedures. This is their canonical home: the
// daemon yields them and the browser client consumes them from the same schema, so the two can't drift (they
// used to be hand-duplicated across repos). Schemas, not bare types, because oRPC's `eventIterator(...)`
// validates each frame against them.

// One interactive question the agent asks via the `ask` tool (mirrors AskUserQuestion's input shape).
export const AskOptionSchema = z.object({
    label: z.string(),
    description: z.string(),
    preview: z.string().optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskQuestionSchema = z.object({
    question: z.string(),
    header: z.string(),
    multiSelect: z.boolean(),
    options: z.array(AskOptionSchema),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

// One frame from an agent turn, relayed to the UI. `kind`-discriminated. `tool` surfaces agent actions
// ("editing <file>" / "running <command>") so the UI shows what the agent is doing; `plan` and `question`
// pause the turn until the user answers on a side channel (agent.decision / agent.answer).
export const AgentEventSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), sessionId: z.string() }),
    z.object({ kind: z.literal("delta"), text: z.string() }),
    z.object({ kind: z.literal("tool"), name: z.string(), target: z.string().optional() }),
    z.object({ kind: z.literal("plan"), decisionId: z.string(), text: z.string() }),
    z.object({ kind: z.literal("question"), requestId: z.string(), questions: z.array(AskQuestionSchema) }),
    z.object({ kind: z.literal("error"), message: z.string() }),
    z.object({ kind: z.literal("done") }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// One parsed line from `intentic … --output ndjson` (engine events, provider `log`, the terminal `result`).
// Open-ended by design — the sandbox consumes the wire shape, not @intentic/engine's types — so a string
// `kind` plus arbitrary extra fields pass through.
export const IntenticLineSchema = z.looseObject({ kind: z.string() });
export type IntenticLine = z.infer<typeof IntenticLineSchema>;

// The daemon's liveness heartbeat frame: the browser holds the events stream open and trips a watchdog if the
// frames stop (the tunnel drops the proxied response when the origin dies).
export const HeartbeatSchema = z.object({ kind: z.literal("heartbeat") });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
