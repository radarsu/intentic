import type { DesiredStateGraph } from "@intentic/graph";

// Golden expected output for ../deploy.config.ts — regenerated from the compiled graph. Captures the
// platform-self-init ordering (the tunnel comes up before the control plane that reaches Forgejo/Komodo
// through its public routes) and the CI/CD wiring: per-environment `ci` nodes (a Forgejo Actions workflow +
// repo secrets) and Komodo `deployment` nodes pointed at the registry image — no Komodo Build, no deploy-hook.
// Guarded by the topo-order, ref-edge, and secret tests.
export const expectedGraph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: {
            id: "host",
            type: "host",
            inputs: {
                address: "203.0.113.10",
                user: "deploy",
                sshKey: {
                    $secret: {
                        source: "env",
                        key: "HOST_SSH_KEY",
                    },
                },
            },
            dependsOn: [],
        },
        cf: {
            id: "cf",
            type: "cloudflare",
            inputs: {
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                zone: "example.com",
            },
            dependsOn: [],
        },
        "host-git": {
            id: "host-git",
            type: "forgejo",
            inputs: {
                server: {
                    $ref: "host",
                },
                address: "203.0.113.10",
                user: "deploy",
                sshKey: {
                    $secret: {
                        source: "env",
                        key: "HOST_SSH_KEY",
                    },
                },
                internalIp: {
                    $ref: "host.internalIp",
                },
                domain: "git.example.com",
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
            },
            dependsOn: ["host"],
            readyWhen: {
                check: "httpOk",
                url: {
                    $ref: "host-git.internalUrl",
                },
                timeout: "120s",
            },
        },
        "host-git-runner": {
            id: "host-git-runner",
            type: "forgejo-runner",
            inputs: {
                server: {
                    $ref: "host",
                },
                address: "203.0.113.10",
                user: "deploy",
                sshKey: {
                    $secret: {
                        source: "env",
                        key: "HOST_SSH_KEY",
                    },
                },
                instanceUrl: {
                    $ref: "host-git.internalUrl",
                },
                token: {
                    $ref: "host-git.runnerToken",
                },
            },
            dependsOn: ["host", "host-git"],
        },
        "host-deploy": {
            id: "host-deploy",
            type: "komodo",
            inputs: {
                server: {
                    $ref: "host",
                },
                address: "203.0.113.10",
                user: "deploy",
                sshKey: {
                    $secret: {
                        source: "env",
                        key: "HOST_SSH_KEY",
                    },
                },
                internalIp: {
                    $ref: "host.internalIp",
                },
                domain: "komodo.example.com",
                forgejoUrl: {
                    $ref: "host-git.internalUrl",
                },
                runnerToken: {
                    $ref: "host-git.runnerToken",
                },
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                gitAccount: "intentic",
                gitToken: {
                    $ref: "host-git.gitToken",
                },
                registry: "127.0.0.1:3000",
                packagesToken: {
                    $ref: "host-git.packagesToken",
                },
            },
            dependsOn: ["host", "host-git"],
            readyWhen: {
                check: "httpOk",
                url: {
                    $ref: "host-deploy.internalUrl",
                },
                timeout: "90s",
            },
        },
        "cf-git-example-com": {
            id: "cf-git-example-com",
            type: "cf-route",
            inputs: {
                hostname: "git.example.com",
                zoneId: {
                    $ref: "cf.zoneId",
                },
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                cname: {
                    $ref: "host-tunnel.cname",
                },
            },
            dependsOn: ["cf", "host-tunnel"],
        },
        "cf-komodo-example-com": {
            id: "cf-komodo-example-com",
            type: "cf-route",
            inputs: {
                hostname: "komodo.example.com",
                zoneId: {
                    $ref: "cf.zoneId",
                },
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                cname: {
                    $ref: "host-tunnel.cname",
                },
            },
            dependsOn: ["cf", "host-tunnel"],
        },
        "my-app-repo": {
            id: "my-app-repo",
            type: "repo",
            inputs: {
                name: "my-app",
                private: true,
                forgejoUrl: {
                    $ref: "host-git.url",
                },
                domain: "git.example.com",
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
            },
            dependsOn: ["host-git", "cf-git-example-com"],
        },
        "my-app.staging-ci": {
            id: "my-app.staging-ci",
            type: "ci",
            inputs: {
                forgejoUrl: {
                    $ref: "host-git.url",
                },
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
                komodoPassword: {
                    $secret: {
                        source: "generated",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                repoName: "my-app",
                branch: "develop",
                registry: "127.0.0.1:3000",
                tag: "staging",
                packagesToken: {
                    $ref: "host-git.packagesToken",
                },
                komodoUrl: {
                    $ref: "host-deploy.internalUrl",
                },
                deployment: "my-app.staging",
            },
            dependsOn: ["host-git", "cf-git-example-com", "host-deploy", "my-app-repo"],
        },
        "my-app.staging": {
            id: "my-app.staging",
            type: "deployment",
            inputs: {
                repoName: "my-app",
                registry: "127.0.0.1:3000",
                tag: "staging",
                domain: "staging.example.com",
                internalIp: {
                    $ref: "host.internalIp",
                },
                port: 27748,
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                env: {
                    DATABASE_URL: {
                        $secret: {
                            source: "env",
                            key: "STAGING_DATABASE_URL",
                        },
                    },
                },
            },
            dependsOn: ["my-app.staging-ci", "cf-komodo-example-com", "host", "host-deploy"],
        },
        "cf-staging-example-com": {
            id: "cf-staging-example-com",
            type: "cf-route",
            inputs: {
                hostname: "staging.example.com",
                zoneId: {
                    $ref: "cf.zoneId",
                },
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                cname: {
                    $ref: "host-tunnel.cname",
                },
            },
            dependsOn: ["cf", "host-tunnel"],
        },
        "my-app.production-ci": {
            id: "my-app.production-ci",
            type: "ci",
            inputs: {
                forgejoUrl: {
                    $ref: "host-git.url",
                },
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
                komodoPassword: {
                    $secret: {
                        source: "generated",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                repoName: "my-app",
                branch: "main",
                registry: "127.0.0.1:3000",
                tag: "production",
                packagesToken: {
                    $ref: "host-git.packagesToken",
                },
                komodoUrl: {
                    $ref: "host-deploy.internalUrl",
                },
                deployment: "my-app.production",
            },
            dependsOn: ["host-git", "cf-git-example-com", "host-deploy", "my-app-repo"],
        },
        "my-app.production": {
            id: "my-app.production",
            type: "deployment",
            inputs: {
                repoName: "my-app",
                registry: "127.0.0.1:3000",
                tag: "production",
                domain: "app.example.com",
                internalIp: {
                    $ref: "host.internalIp",
                },
                port: 23104,
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                adminUser: "intentic",
                adminPassword: {
                    $secret: {
                        source: "generated",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                env: {
                    DATABASE_URL: {
                        $secret: {
                            source: "env",
                            key: "PRODUCTION_DATABASE_URL",
                        },
                    },
                },
            },
            dependsOn: ["my-app.production-ci", "cf-komodo-example-com", "host", "host-deploy"],
        },
        "cf-app-example-com": {
            id: "cf-app-example-com",
            type: "cf-route",
            inputs: {
                hostname: "app.example.com",
                zoneId: {
                    $ref: "cf.zoneId",
                },
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                cname: {
                    $ref: "host-tunnel.cname",
                },
            },
            dependsOn: ["cf", "host-tunnel"],
        },
        "host-tunnel": {
            id: "host-tunnel",
            type: "tunnel",
            inputs: {
                name: "intentic-host",
                accountId: {
                    $ref: "cf.accountId",
                },
                apiToken: {
                    $secret: {
                        source: "env",
                        key: "CLOUDFLARE_API_TOKEN",
                    },
                },
                address: "203.0.113.10",
                user: "deploy",
                sshKey: {
                    $secret: {
                        source: "env",
                        key: "HOST_SSH_KEY",
                    },
                },
                internalIp: {
                    $ref: "host.internalIp",
                },
                ingress: [
                    {
                        hostname: "git.example.com",
                        port: 3000,
                    },
                    {
                        hostname: "komodo.example.com",
                        port: 9120,
                    },
                    {
                        hostname: "staging.example.com",
                        port: 27748,
                    },
                    {
                        hostname: "app.example.com",
                        port: 23104,
                    },
                ],
            },
            dependsOn: ["cf", "host"],
        },
    },
};
