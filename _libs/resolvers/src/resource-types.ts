import type { RawNode } from "@puristic/deploy-protocol";

// The closed vocabulary of resource kinds this resolver stack derives. The protocol IR treats a node's
// `type` as an opaque string; this union is the resolver's authority on which kinds it emits, and the
// key space for OUTPUTS.
export type ResourceType = "host" | "cloudflare" | "cf-route" | "forgejo" | "repo" | "forgejo-runner" | "komodo" | "app" | "deployment";

// A RawNode whose kind is constrained to this stack's vocabulary. Resolvers build ResolvedNodes so an
// invalid kind is a compile error here; they flow out as plain RawNodes (ResourceType ⊆ string).
export type ResolvedNode = Omit<RawNode, "type"> & { readonly type: ResourceType };
