# puristic-deploy

A pnpm + Turbo monorepo of TypeScript packages for solo-dev deployment.

## Packages

| Package | Description |
| --- | --- |
| [`@puristic/deploy-protocol`](_libs/protocol) | Product-agnostic desired-state IR: refs, secrets, readiness, the serializable graph, and the compiler. |
| [`@puristic/deploy-resolvers`](_libs/resolvers) | Resolves intent into concrete resources — the app resolver derives the Forgejo/Komodo/Cloudflare support stack. |
| [`@puristic/deploy-core`](_libs/core) | Authoring surface (`i.have` / `i.want`) and `defineStack`: build → resolve → compile. |
| [`@puristic/deploy-engine`](_libs/engine) | Stateless reconcile engine: `plan` / `apply` a `DesiredStateGraph` onto infra via the Provider SPI. |
| [`@puristic/deploy-providers`](_libs/providers) | Real reconcile providers over the engine SPI — a `host` provider over SSH (`ssh2`). |

## Getting started

```sh
pnpm install
pnpm build         # turbo build across packages
pnpm test
pnpm libs:watch    # incremental TypeScript build in watch mode
```

> Requires **Node 24** and **pnpm 11**.

## License

MIT
