// The ownership-stamp contract: defined ONCE in the protocol, applied per-provider in its native mechanism.
// A provider stamps every resource it creates with the resource node's id, so a later stateless
// read (introspect) can attribute it without any local state file. The KEY is canonical here; the
// stamp value is always the compiled ResourceNode.id.
//
// Mechanisms differ per backend: a single-string field (a Cloudflare DNS record comment) carries the
// `formatStamp` encoding, while a key/value mechanism (a Docker label) uses STAMP_KEY as the label key
// and the id as the value directly. parseStamp recovers the id from the single-string form.

export const STAMP_KEY = "puristic.id";

export const formatStamp = (id: string): string => `${STAMP_KEY}=${id}`;

export const parseStamp = (encoded: string): string | undefined => {
    const prefix = `${STAMP_KEY}=`;
    return encoded.startsWith(prefix) ? encoded.slice(prefix.length) : undefined;
};
