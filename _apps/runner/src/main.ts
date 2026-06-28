import { serve } from "@hono/node-server";
import { createPreviewProxy } from "./proxy-server.js";

// The runner container's entrypoint. This increment starts the host-published preview reverse proxy that the
// wildcard `*.preview.<zone>` tunnel ingress points at. The outbound control channel to the platform (which
// drives dispatch() over WS) is wired in Phase 3, once the platform gateway exists.
const zone = process.env["ZONE"] ?? "";
const previewPort = Number(process.env["PREVIEW_PORT"] ?? "8088");
const devPort = Number(process.env["SANDBOX_DEV_PORT"] ?? "5173");

const proxy = createPreviewProxy({ zone, devPort });
serve({ fetch: proxy.fetch, port: previewPort, hostname: "0.0.0.0" });
process.stdout.write(`intentic runner: preview proxy on 0.0.0.0:${previewPort} for *.preview.${zone}\n`);
process.stdout.write("intentic runner: platform control channel is wired in Phase 3\n");
