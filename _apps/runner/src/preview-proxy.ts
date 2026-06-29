import { sandboxName } from "./sandbox-manager.js";

// A preview hostname is `<sub>.preview.<zone>` and the wildcard tunnel route `*.preview.<zone>` sends every
// such host to the runner's proxy. Extract `<sub>` — the project — or undefined when the host is not a
// single-label preview subdomain (empty or dotted subdomains are rejected so only `<project>.preview.<zone>`
// matches, never a deeper name).
export const previewSubdomain = (host: string, zone: string): string | undefined => {
    const suffix = `.preview.${zone}`;
    if (!host.endsWith(suffix)) {
        return undefined;
    }
    const sub = host.slice(0, host.length - suffix.length);
    return sub === "" || sub.includes(".") ? undefined : sub;
};

// The sandbox dev-server URL a preview host resolves to. One sandbox per project ⇒ the subdomain IS the
// project, so the target is that project's sandbox container on the shared network at its dev port. The
// reverse-proxy server (next increment) forwards the request here.
export const previewTarget = (host: string, zone: string, devPort: number): string | undefined => {
    const project = previewSubdomain(host, zone);
    return project === undefined ? undefined : `http://${sandboxName(project)}:${devPort}`;
};

// The sandbox DAEMON URL a preview host resolves to — same container, the daemon port instead of the dev
// server. Used for the `/__agent` route so the browser can drive the agent directly through the tunnel.
export const agentTarget = (host: string, zone: string, daemonPort: number): string | undefined => {
    const project = previewSubdomain(host, zone);
    return project === undefined ? undefined : `http://${sandboxName(project)}:${daemonPort}`;
};
