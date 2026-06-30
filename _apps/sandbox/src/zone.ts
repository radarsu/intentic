// Derive the Cloudflare zone from the sandbox's public URL (https://sandbox-<hash>.<zone> → <zone>): the host
// minus its first label. Undefined when there's no public URL (the preview-only provider-deployed sandbox) or
// the host has no zone suffix. main.ts uses it to seed the scaffolded app's domain (app.<zone>) when ZONE is
// not set explicitly.
export const zoneFromPublicUrl = (url: string | undefined): string | undefined => {
    if (url === undefined || url === "") {
        return undefined;
    }
    const hostname = url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
    const dot = hostname.indexOf(".");
    return dot === -1 ? undefined : hostname.slice(dot + 1);
};
