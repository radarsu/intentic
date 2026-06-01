import type { Ref, SecretRef } from "./types.js";

export const makeRef = (resourceId: string, output?: string): Ref<unknown> =>
    Object.freeze(output === undefined ? { kind: "ref", resourceId } : { kind: "ref", resourceId, output });

export const isRef = (value: unknown): value is Ref<unknown> =>
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "ref";

export const isSecret = (value: unknown): value is SecretRef =>
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "secret";
