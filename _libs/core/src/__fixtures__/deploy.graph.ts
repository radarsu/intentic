import type { DesiredStateGraph } from "@puristic/deploy-protocol";

// Golden expected output for ../deploy.config.ts — regenerated from the compiled graph after the
// full-platform-suite resolver change: SSH-cred + internalIp threading into forgejo/forgejo-runner/komodo,
// internal readyWhen gates (so readiness passes before the tunnel + DNS exist), config-provider auth
// inputs (forgejoUrl/komodoUrl + admin password), the shared KOMODO_WEBHOOK_SECRET, and a per-environment
// push-to-deploy webhook node. Independently guarded by the topo-order, ref-edge, and secret tests.
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
                accountId: "acc_123",
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
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
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
                    $ref: "host-git.url",
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
                adminPassword: {
                    $secret: {
                        source: "env",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
                webhookSecret: {
                    $secret: {
                        source: "env",
                        key: "KOMODO_WEBHOOK_SECRET",
                    },
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
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
            },
            dependsOn: ["host-git"],
        },
        "my-app": {
            id: "my-app",
            type: "app",
            inputs: {
                source: {
                    $ref: "my-app-repo.cloneUrl",
                },
                repoName: "my-app",
                deployer: {
                    $ref: "host-deploy",
                },
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                gitDomain: "git.example.com",
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
                        key: "KOMODO_ADMIN_PASSWORD",
                    },
                },
            },
            dependsOn: ["host-deploy", "my-app-repo"],
        },
        "my-app.staging": {
            id: "my-app.staging",
            type: "deployment",
            inputs: {
                app: {
                    $ref: "my-app",
                },
                name: "staging",
                branch: "develop",
                domain: "staging.example.com",
                server: {
                    $ref: "host",
                },
                internalIp: {
                    $ref: "host.internalIp",
                },
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
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
            dependsOn: ["my-app", "host", "host-deploy"],
            readyWhen: {
                check: "httpOk",
                url: {
                    $ref: "my-app.staging.internalUrl",
                },
                timeout: "60s",
            },
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
        "my-app.staging-deploy-hook": {
            id: "my-app.staging-deploy-hook",
            type: "deploy-hook",
            inputs: {
                forgejoUrl: {
                    $ref: "host-git.url",
                },
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
                repoName: "my-app",
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                deployment: "my-app.staging",
                branch: "develop",
                secret: {
                    $secret: {
                        source: "env",
                        key: "KOMODO_WEBHOOK_SECRET",
                    },
                },
            },
            dependsOn: ["my-app-repo", "my-app.staging", "host-git", "host-deploy"],
        },
        "my-app.production": {
            id: "my-app.production",
            type: "deployment",
            inputs: {
                app: {
                    $ref: "my-app",
                },
                name: "production",
                branch: "main",
                domain: "app.example.com",
                server: {
                    $ref: "host",
                },
                internalIp: {
                    $ref: "host.internalIp",
                },
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
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
            dependsOn: ["my-app", "host", "host-deploy"],
            readyWhen: {
                check: "httpOk",
                url: {
                    $ref: "my-app.production.internalUrl",
                },
                timeout: "60s",
            },
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
        "my-app.production-deploy-hook": {
            id: "my-app.production-deploy-hook",
            type: "deploy-hook",
            inputs: {
                forgejoUrl: {
                    $ref: "host-git.url",
                },
                adminUser: "admin",
                adminPassword: {
                    $secret: {
                        source: "env",
                        key: "FORGEJO_ADMIN_PASSWORD",
                    },
                },
                repoName: "my-app",
                komodoUrl: {
                    $ref: "host-deploy.url",
                },
                deployment: "my-app.production",
                branch: "main",
                secret: {
                    $secret: {
                        source: "env",
                        key: "KOMODO_WEBHOOK_SECRET",
                    },
                },
            },
            dependsOn: ["my-app-repo", "my-app.production", "host-git", "host-deploy"],
        },
        "host-tunnel": {
            id: "host-tunnel",
            type: "tunnel",
            inputs: {
                name: "puristic-host",
                accountId: "acc_123",
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
                ingress: [
                    {
                        hostname: "git.example.com",
                        service: {
                            $ref: "host-git.internalUrl",
                        },
                    },
                    {
                        hostname: "komodo.example.com",
                        service: {
                            $ref: "host-deploy.internalUrl",
                        },
                    },
                    {
                        hostname: "staging.example.com",
                        service: {
                            $ref: "my-app.staging.internalUrl",
                        },
                    },
                    {
                        hostname: "app.example.com",
                        service: {
                            $ref: "my-app.production.internalUrl",
                        },
                    },
                ],
            },
            dependsOn: ["cf", "host", "host-git", "host-deploy", "my-app.staging", "my-app.production"],
        },
    },
};
