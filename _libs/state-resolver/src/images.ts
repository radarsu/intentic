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
// SigNoz caveat: the SigNoz stack (signoz/clickhouse/otel/schema-migrator) is an interdependent quartet whose
// collector + clickhouse-cluster configs in signoz.ts target a specific SigNoz line. These are pinned to the
// 0.111.x-era contemporaries the existing configs were written against (the previously-referenced
// signoz:0.64.0 tag no longer exists upstream). Treat a SigNoz major bump as a dedicated migration that also
// revisits those configs, grouped by Renovate — not an incidental pin bump.
export const IMAGES = Object.freeze({
    // renovate: datasource=docker depName=codeberg.org/forgejo/forgejo
    forgejo: "codeberg.org/forgejo/forgejo:15.0.3@sha256:55bb42bec9abef5223744804f164e37d37b20df7e8b8b4807ba213ad4f071d6d",
    // renovate: datasource=docker depName=data.forgejo.org/forgejo/runner
    forgejoRunner: "data.forgejo.org/forgejo/runner:6.4.0@sha256:e8dd2880f2fc81984d2308b93f1bc064dfb41187942300676536c09a3b30043d",
    // The image act_runner runs each `runs-on: docker` job in (carries node; the docker CLI + buildx are
    // bind-mounted from the host by the runner provider). renovate: datasource=docker depName=data.forgejo.org/oci/node
    forgejoRunnerJob: "data.forgejo.org/oci/node:20-bullseye@sha256:c0122351f25f04facee976f9db7214789eabadb489f4e4aea9cd00a0d6af77c4",
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
    // renovate: datasource=docker depName=clickhouse/clickhouse-server
    clickhouse: "clickhouse/clickhouse-server:24.1.2-alpine@sha256:1db999ade4b8c16397c42a3818881eba7e8a35369ce53e6374bf9cf498d87d28",
    // renovate: datasource=docker depName=signoz/signoz
    signoz: "signoz/signoz:v0.111.0@sha256:22d0cf6321dc794e0d902d34e5a8925ec412642be5c9b5084147dbe9bc8f9637",
    // renovate: datasource=docker depName=signoz/signoz-otel-collector
    signozOtelCollector: "signoz/signoz-otel-collector:0.111.5@sha256:d5210dc6ad4f5d5e2c5126c059de0b58bb19bc2019753d0d022aef0bdb879e0f",
    // renovate: datasource=docker depName=signoz/signoz-schema-migrator
    signozSchemaMigrator: "signoz/signoz-schema-migrator:0.111.5@sha256:7fce30f15229f096b72360ee5adc6f6a491ced60ae57d842bc03163445e1c10c",
    // The scheduled-backup container: alpine-based, carries restic + busybox crond. It has no docker CLI, so
    // the backup provider bind-mounts the host's docker binary (the forgejo-runner pattern) for the
    // app-consistent `docker exec` dumps. renovate: datasource=docker depName=restic/restic
    backup: "restic/restic:0.19.0@sha256:7f44e0057b82348597568ea209360762d0b38f8e1dbc8ad859661ac1055e45f2",
    // The Postgres backing instance (i.want.database). Plain upstream postgres; the binding provider creates
    // per-app databases + roles in it via `docker exec … psql`. The @sha256 below is a PLACEHOLDER digest —
    // Renovate pins the real one on its first PR (pinDigests), and the e2e harness must run only against a
    // pinned digest. renovate: datasource=docker depName=postgres
    postgres: "postgres:17.6-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    // The Valkey backing instance (i.want.cache). The binding provider mints a per-app ACL user in it via
    // `docker exec … valkey-cli`. PLACEHOLDER digest, pinned by Renovate (see postgres above).
    // renovate: datasource=docker depName=valkey/valkey
    valkey: "valkey/valkey:8.1.1-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000",
} as const);
