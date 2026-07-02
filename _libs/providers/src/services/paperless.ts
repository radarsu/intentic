import type { Provider } from "@intentic/engine";
import { z } from "zod";
import type { SshExecutor } from "../core/ssh.js";
import { sshExecutor } from "../core/ssh.js";
import { createComposeServiceProvider, serviceSchema } from "./compose-service.js";

const paperlessSchema = serviceSchema.extend({
    // Paperless seeds its first superuser from env on first boot (idempotent: skipped when the user exists),
    // so the intentic-generated admin identity rides the write-once .env — no register call needed.
    adminUser: z.string(),
    adminPassword: z.string(),
    paperlessImage: z.string(),
    valkeyImage: z.string(),
});
type PaperlessInputs = z.infer<typeof paperlessSchema>;

const PORT = 8000;

// Paperless-ngx on SQLite (its default when PAPERLESS_DBHOST is unset — one fewer container) with the
// valkey broker it needs for its task queue. PAPERLESS_URL makes CSRF trust the tunnel-routed https origin.
const composeYaml = (parsed: PaperlessInputs): string =>
    [
        "services:",
        "  broker:",
        `    image: ${parsed.valkeyImage}`,
        "    restart: unless-stopped",
        "    volumes: [ brokerdata:/data ]",
        "  paperless:",
        `    image: ${parsed.paperlessImage}`,
        "    restart: unless-stopped",
        "    depends_on: [ broker ]",
        `    ports: [ "${PORT}:8000" ]`,
        // The secret key + admin password live in the write-once .env (chmod 600), not here.
        "    env_file: ./.env",
        "    environment:",
        "      - PAPERLESS_REDIS=redis://broker:6379",
        `      - PAPERLESS_URL=https://${parsed.domain}`,
        `      - PAPERLESS_ADMIN_USER=${parsed.adminUser}`,
        `      - PAPERLESS_ADMIN_MAIL=${parsed.adminUser}`,
        "    volumes:",
        "      - data:/usr/src/paperless/data",
        "      - media:/usr/src/paperless/media",
        "      - export:/usr/src/paperless/export",
        "      - consume:/usr/src/paperless/consume",
        `    labels: [ "intentic.id=intentic-paperless" ]`,
        "volumes: { brokerdata: {}, data: {}, media: {}, export: {}, consume: {} }",
        "",
    ].join("\n");

// Paperless-ngx (documents): scan, index and archive. The root URL redirects to the login page, which
// answers 200 once the app is migrated and up — that redirect chain is the readiness probe.
export const createPaperlessProvider = (executor: SshExecutor = sshExecutor): Provider =>
    createComposeServiceProvider(
        {
            kind: "paperless",
            schema: paperlessSchema,
            port: PORT,
            healthPath: "",
            files: (parsed) => ({ "compose.yaml": composeYaml(parsed) }),
            env: (parsed) => [{ key: "PAPERLESS_SECRET_KEY" }, { key: "PAPERLESS_ADMIN_PASSWORD", value: parsed.adminPassword }],
            images: (parsed) => ({ broker: parsed.valkeyImage, paperless: parsed.paperlessImage }),
        },
        executor,
    );
