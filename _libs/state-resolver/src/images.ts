// The single authority for every docker image intentic deploys. Each value is a fully immutable reference —
// `repo:tag@sha256:digest` — so an upstream re-push of a tag can never silently change what runs; only a
// commit that edits this file (by hand or a merged Renovate PR) moves a version. The resolver reads these
// and emits them as resource INPUTS into the desired-state graph, so the deployed version is recorded in
// desired-state.json: git-reviewable, diffable, and reconciled (a changed pin makes the provider's `diff`
// report drift and `apply` recreate on the new image). Rollback is `git revert` + re-apply.
//
// Renovate is pointed at this file (see renovate.json5) with pinDigests on, so it bumps both the tag and the
// `@sha256:` digest on each entry from the `renovate:` hint comment above it.
//
// SigNoz caveat: the SigNoz stack (signoz/clickhouse/otel/zookeeper) is an interdependent set whose compose +
// collector + clickhouse configs in signoz.ts mirror SigNoz's reference deploy/docker. They are pinned to the
// v0.129.0 reference — the NEWEST SigNoz release that still ships a reference compose (v0.130+ dropped compose
// self-hosting in favour of "Foundry"). A SigNoz bump is therefore a dedicated migration that re-ports those
// configs from the matching tag, grouped by Renovate — not an incidental pin bump — and upstream has
// deprecated this deployment mode, so treat the whole stack as e2e-validated and pinned deliberately.
export const IMAGES = Object.freeze({
    // renovate: datasource=docker depName=codeberg.org/forgejo/forgejo
    forgejo: "codeberg.org/forgejo/forgejo:15.0.3@sha256:55bb42bec9abef5223744804f164e37d37b20df7e8b8b4807ba213ad4f071d6d",
    // renovate: datasource=docker depName=data.forgejo.org/forgejo/runner
    forgejoRunner: "data.forgejo.org/forgejo/runner:12.12.0@sha256:268ad0d1d24bd7ecf2386b7c44e8211398dc014ca81d4fd5fbad96fe79af18f5",
    // The image act_runner runs each `runs-on: docker` job in (carries node; the docker CLI + buildx are
    // bind-mounted from the host by the runner provider). renovate: datasource=docker depName=data.forgejo.org/oci/node
    forgejoRunnerJob: "data.forgejo.org/oci/node:24-bookworm@sha256:fdddfb3e688158251943d52eba361de991548f6814007acba4917ae6b512d6be",
    // renovate: datasource=docker depName=cloudflare/cloudflared
    cloudflared: "cloudflare/cloudflared:2026.6.1@sha256:6d91c121b803126f7a5344005d17a9324788fc09d305b6e2560ec6040a7ae283",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-core
    komodoCore: "ghcr.io/moghtech/komodo-core:2.1.0@sha256:4915d91b5c6e9de4e8fd59391eed5cad090ec84dcf6a1a9233d97edfdbbb88e7",
    // renovate: datasource=docker depName=ghcr.io/moghtech/komodo-periphery
    komodoPeriphery: "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:f5b272e3d9acd60d4eac69ea4fa0292dcaddfdecfc2be64ba5575e5ae18e72ae",
    // renovate: datasource=docker depName=ghcr.io/ferretdb/ferretdb
    ferretdb: "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:5706414241eb84f0515512c37b46db0f1b1eac9e5ceb7e4c2523211c184b1985",
    // The documentdb-extended postgres FerretDB runs on; its tag is paired with the FerretDB version above.
    // renovate: datasource=docker depName=ghcr.io/ferretdb/postgres-documentdb
    postgresDocumentdb:
        "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7",
    // The SigNoz stack, pinned to the v0.129.0 reference deploy/docker set (the newest SigNoz release that
    // still ships a reference compose; v0.130 dropped compose self-hosting). ClickHouse is the non-alpine tag
    // SigNoz tests against, paired with a separate ZooKeeper; the migrator runs from the otel-collector image.
    // renovate: datasource=docker depName=clickhouse/clickhouse-server
    clickhouse: "clickhouse/clickhouse-server:25.5.6@sha256:4536143e22dc9bddb217c7e610f6b7ed5e6efd8fefdbc61acdeadb5d8022213a",
    // renovate: datasource=docker depName=signoz/signoz
    signoz: "signoz/signoz:v0.129.0@sha256:50447bb4461c075f52b8fe331324db389f7475b0b6abd1f0a4c9ce7ab3967ca8",
    // The OTel collector image; the schema/telemetrystore migrator runs from this same image at v0.129.
    // renovate: datasource=docker depName=signoz/signoz-otel-collector
    signozOtelCollector: "signoz/signoz-otel-collector:v0.144.5@sha256:f9bf94d566055d06581f3befbf361cc26d670f31ad00cb31fda2ec380210c5ec",
    // The ClickHouse coordination ZooKeeper SigNoz's reference uses (a Bitnami-based image). renovate: datasource=docker depName=signoz/zookeeper
    signozZookeeper: "signoz/zookeeper:3.7.1@sha256:fcc4a3288154ccaa3bdb5ae6dc10180c084d29a8a6a26b62ac8e30a8940dc2e6",
    // The scheduled-backup container: alpine-based, carries restic + busybox crond. It has no docker CLI, so
    // the backup provider bind-mounts the host's docker binary (the forgejo-runner pattern) for the
    // app-consistent `docker exec` dumps. renovate: datasource=docker depName=restic/restic
    backup: "restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2",
    // The Postgres backing instance (i.want.database). Plain upstream postgres; the binding provider creates
    // per-app databases + roles in it via `docker exec … psql`. Also the DB the Authentik auth instance
    // bundles. renovate: datasource=docker depName=postgres
    postgres: "postgres:18.4-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa",
    // The Valkey backing instance (i.want.cache). The binding provider mints a per-app ACL user in it via
    // `docker exec … valkey-cli`. Also the redis-compatible cache the Authentik auth instance bundles.
    // renovate: datasource=docker depName=valkey/valkey
    valkey: "valkey/valkey:9.1.0-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd",
    // The Authentik server (i.want.auth). The instance provider runs it as a compose stack (server + worker +
    // the bundled postgres/valkey above); the binding provider mints a per-app OIDC client via its HTTP API.
    // renovate: datasource=docker depName=ghcr.io/goauthentik/server
    authentik: "ghcr.io/goauthentik/server:2026.2.4@sha256:0ed7e84cef9d0051659dba5cf63a860a485f85b3fff698c8d2fff17fa3cbe596",
    // The Garage S3-compatible object store (i.want.objectStorage). Single container; the binding provider
    // mints a per-app bucket + access key via `docker exec … garage`. renovate: datasource=docker depName=dxflrs/garage
    garage: "dxflrs/garage:v2.3.0@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690",
    // The first-party intentic image built from _apps/sandbox (the AI-agent workspace), published to the repo's
    // GHCR by scripts/publish-images.sh — continuously on push to main (latest + commit SHA) and version-tagged
    // on release. The GHCR package must be public so tenant hosts can pull it. Pin a RELEASE version (tag +
    // digest): its bundled CLI + @intentic/* are published to npm at that version, so `intentic init` resolves.
    // Never :latest or a hand-tagged build — those carry internal version 0.0.0 (unpublished), so init's
    // `pnpm install` of ~0.0.0 deps fails and resolve can't find @intentic/graph.
    // renovate: datasource=docker depName=ghcr.io/radarsu/intentic/sandbox
    sandbox: "ghcr.io/radarsu/intentic/sandbox:1.32.0@sha256:434dda985897f3efd8246b045dbd6cc9af1c679ee7faf55e1f4c51db303df7c8",
} as const);
