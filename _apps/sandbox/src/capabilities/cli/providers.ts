import type { CliConfig } from "@intentic/sandbox-contract";

// The curated seam for CLI-tool integrations: each provider maps its manifest config to (1) the env vars the
// agent's shell needs (injected per turn by cliEnvOf) and (2) the SKILL.md cheatsheet dropped into the
// workspace's .claude/skills/<id> so the agent knows the tool exists and how to call it. All providers drive
// the provider's REST API with curl + jq (both in the sandbox image). Adding a provider is one entry here plus
// a CliConfigSchema variant — no new capability plumbing. Non-secret URLs ride in env too, so each skill is
// static text that reads $PROVIDER_URL / $PROVIDER_TOKEN.
export interface CliProvider {
    readonly env: (config: CliConfig) => Record<string, string>;
    readonly skill: string;
}

const DISCORD_SKILL = `---
name: discord
description: Read, post, and react in the connected Discord server via the Discord REST API, and help the user invite the bot / finish setup. Use when the user asks to send a Discord message, list channels/servers, read or react to messages, or connect/invite the bot.
---

# Discord (connected)

Authenticated with a bot token in \`$DISCORD_BOT_TOKEN\`. Talk to Discord's REST API with \`curl\`.
Base URL: \`https://discord.com/api/v10\` — Auth header: \`-H "Authorization: Bot $DISCORD_BOT_TOKEN"\`.

## Setup & invite (do this when the bot isn't in the user's server yet)
Discord only lets a server admin add a bot via an OAuth consent link — generate that link for them:
1. Confirm the token works and get the bot user:
   \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me | jq '{id, username}'\`
2. Get the application id (needed for the invite URL):
   \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/oauth2/applications/@me | jq '{id, name}'\`
3. Give the user this invite link (they open it, pick their server, approve):
   \`https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=68672\`
   Permissions 68672 = View Channels + Send Messages + Read Message History + Add Reactions (read/list/react/send).
4. Tell them: in the Developer Portal → your app → Bot, enable the **Message Content** privileged intent
   (required to read message text; it can't be toggled via the API). Reading needs it; posting does not.
Then confirm it landed: \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'\`

## Common commands
- List the bot's servers:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'\`
- List channels in a server:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/guilds/<GUILD_ID>/channels | jq '.[] | {id, name, type}'\`
- Read recent messages:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/<CHANNEL_ID>/messages?limit=20" | jq '.[] | {id, author: .author.username, content}'\`
- React to a message (URL-encode the emoji; unicode 👍 = %F0%9F%91%8D):
  \`curl -s -X PUT -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/<CHANNEL_ID>/messages/<MESSAGE_ID>/reactions/%F0%9F%91%8D/@me"\`
- Send a message:
  \`curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d '{"content":"hello"}' https://discord.com/api/v10/channels/<CHANNEL_ID>/messages\`

Notes: IDs come from the list commands above. If a read returns empty content, the Message Content intent isn't enabled (see Setup step 4).
`;

const GITHUB_SKILL = `---
name: github
description: Read and manage GitHub repos, issues, pull requests, and code search via the GitHub REST API. Use when the user asks about GitHub repos, issues, PRs, or code.
---

# GitHub (connected)

Token in \`$GITHUB_TOKEN\`. Talk to \`https://api.github.com\` with \`curl\`.
Headers: \`-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json"\`.

- Who am I: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | jq '{login}'\`
- Your repos: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/user/repos?per_page=50&sort=updated" | jq '.[] | {full_name, private}'\`
- Open issues in a repo: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/issues?state=open" | jq '.[] | {number, title}'\`
- Open pull requests: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/pulls?state=open" | jq '.[] | {number, title}'\`
- Search issues/PRs: \`curl -s -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/search/issues?q=<URL_ENCODED_QUERY>" | jq '.items[] | {number, title, html_url}'\`
- Create an issue: \`curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/<OWNER>/<REPO>/issues" -d '{"title":"...","body":"..."}'\`

Notes: paginate with \`?per_page=100&page=N\`. The token's scopes bound what you can reach.
`;

const GITLAB_SKILL = `---
name: gitlab
description: Read and manage GitLab projects, issues, merge requests, and pipelines via the GitLab REST API. Use when the user asks about GitLab projects, issues, MRs, or pipelines.
---

# GitLab (connected)

Token in \`$GITLAB_TOKEN\`, instance base in \`$GITLAB_URL\`. Talk to \`$GITLAB_URL/api/v4\` with \`curl\`.
Header: \`-H "PRIVATE-TOKEN: $GITLAB_TOKEN"\`.

- Who am I: \`curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/user" | jq '{username}'\`
- Your projects: \`curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects?membership=true&per_page=50" | jq '.[] | {id, path_with_namespace}'\`
- Open issues: \`curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/issues?state=opened" | jq '.[] | {iid, title}'\`
- Open merge requests: \`curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/merge_requests?state=opened" | jq '.[] | {iid, title}'\`
- Recent pipelines: \`curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/pipelines?per_page=10" | jq '.[] | {id, status, ref}'\`
- Create an issue: \`curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/projects/<ID>/issues" --data-urlencode "title=..."\`

Notes: \`<ID>\` is the numeric project id (from the projects list) or a URL-encoded path (group%2Frepo). Self-hosted works — $GITLAB_URL points at your instance.
`;

const SENTRY_SKILL = `---
name: sentry
description: Query Sentry organizations, projects, and unresolved issues/errors via the Sentry API. Use when the user asks about Sentry errors, issues, or projects.
---

# Sentry (connected)

Token in \`$SENTRY_TOKEN\`, base in \`$SENTRY_URL\`, org slug in \`$SENTRY_ORG\` (may be empty). Talk to \`$SENTRY_URL/api/0\` with \`curl\`.
Header: \`-H "Authorization: Bearer $SENTRY_TOKEN"\`.

- If \`$SENTRY_ORG\` is empty, list orgs first and use a slug below:
  \`curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/" | jq '.[] | {slug, name}'\`
- List projects: \`curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/projects/" | jq '.[] | {slug, platform}'\`
- Unresolved issues: \`curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&limit=25" | jq '.[] | {shortId, title, count, culprit}'\`
- Latest event for an issue: \`curl -s -H "Authorization: Bearer $SENTRY_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/<ISSUE_ID>/events/latest/" | jq '{eventID, message}'\`

Notes: SaaS base is https://sentry.io (or a region host like https://us.sentry.io); self-hosted uses your instance URL.
`;

const REDMINE_SKILL = `---
name: redmine
description: Read and manage Redmine projects, issues, and updates via the Redmine REST API. Use when the user asks about Redmine tickets/issues or projects.
---

# Redmine (connected)

Instance in \`$REDMINE_URL\`, API key in \`$REDMINE_API_KEY\`. Talk to \`$REDMINE_URL\` with \`curl\`.
Header: \`-H "X-Redmine-API-Key: $REDMINE_API_KEY"\`.

- Who am I: \`curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/users/current.json" | jq '.user | {id, login}'\`
- Projects: \`curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/projects.json" | jq '.projects[] | {id, identifier, name}'\`
- Open issues: \`curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/issues.json?status_id=open&limit=50" | jq '.issues[] | {id, subject, status: .status.name}'\`
- One issue: \`curl -s -H "X-Redmine-API-Key: $REDMINE_API_KEY" "$REDMINE_URL/issues/<ID>.json" | jq '.issue | {id, subject, description}'\`
- Create an issue: \`curl -s -X POST -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H "Content-Type: application/json" -d '{"issue":{"project_id":<PID>,"subject":"...","description":"..."}}' "$REDMINE_URL/issues.json"\`
- Update an issue: \`curl -s -X PUT -H "X-Redmine-API-Key: $REDMINE_API_KEY" -H "Content-Type: application/json" -d '{"issue":{"notes":"...","status_id":<SID>}}' "$REDMINE_URL/issues/<ID>.json"\`
`;

const OUTLINE_SKILL = `---
name: outline
description: Search, read, and create documents in your Outline wiki via the Outline API. Use when the user asks to find, read, or write Outline docs / knowledge base.
---

# Outline (connected)

Instance in \`$OUTLINE_URL\`, token in \`$OUTLINE_API_KEY\`. The Outline API is JSON POST for everything.
Headers: \`-H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json"\`. Base: \`$OUTLINE_URL/api\`.

- Who am I: \`curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/auth.info" -d '{}' | jq '.data.user | {id, name}'\`
- Search documents: \`curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.search" -d '{"query":"<QUERY>"}' | jq '.data[] | {id: .document.id, title: .document.title, context}'\`
- Read a document: \`curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.info" -d '{"id":"<DOC_ID>"}' | jq '.data | {title, text}'\`
- List collections: \`curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/collections.list" -d '{}' | jq '.data[] | {id, name}'\`
- Create a document: \`curl -s -X POST -H "Authorization: Bearer $OUTLINE_API_KEY" -H "Content-Type: application/json" "$OUTLINE_URL/api/documents.create" -d '{"title":"...","text":"...","collectionId":"<COLLECTION_ID>","publish":true}'\`
`;

const IMAP_SKILL = `---
name: imap
description: Read an email inbox over IMAP — list folders, search, and fetch messages — with curl. Use when the user asks about their email or inbox.
---

# IMAP inbox (connected)

Server \`$IMAP_HOST:$IMAP_PORT\`, login \`$IMAP_USERNAME\` / \`$IMAP_PASSWORD\`. \`curl\` speaks IMAP over TLS (imaps://).
Auth on every command: \`--user "$IMAP_USERNAME:$IMAP_PASSWORD"\`.

- List mailboxes/folders: \`curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT" --user "$IMAP_USERNAME:$IMAP_PASSWORD"\`
- Unread message UIDs in INBOX: \`curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH UNSEEN"\`
- Recent since a date: \`curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH SINCE 01-Jan-2026"\`
- Fetch a message's headers: \`curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>;SECTION=HEADER" --user "$IMAP_USERNAME:$IMAP_PASSWORD"\`
- Fetch a whole message: \`curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>" --user "$IMAP_USERNAME:$IMAP_PASSWORD"\`

Notes: SEARCH returns UIDs; then fetch by \`;UID=\`. Read-oriented. Gmail/Outlook need an app password, not the account password.
`;

const SIGNOZ_SKILL = `---
name: signoz
description: Query observability (services, traces, logs, metrics) from a SigNoz instance via its API. Use when the user asks about app performance, errors, latency, or telemetry in SigNoz.
---

# SigNoz (connected)

Instance in \`$SIGNOZ_URL\`, API key in \`$SIGNOZ_API_KEY\`. Talk to \`$SIGNOZ_URL\` with \`curl\`.
Header: \`-H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY"\`.

- Confirm connectivity: \`curl -s -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" "$SIGNOZ_URL/api/v1/version" | jq '.'\`
- List instrumented services: \`curl -s -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" "$SIGNOZ_URL/api/v1/services" | jq '.'\`
- Query traces/logs/metrics: POST \`$SIGNOZ_URL/api/v3/query_range\` with a JSON builder query (start/end epoch-ms + a composite query). Ask the user which service/metric and time window, then build the body.

Notes: start with /api/v1/version to confirm the key + URL, then /api/v1/services, then query_range for detail. The query_range body is verbose — build it incrementally.
`;

export const cliProviders = {
    discord: { env: (c) => (c.provider === "discord" ? { DISCORD_BOT_TOKEN: c.botToken } : {}), skill: DISCORD_SKILL },
    github: { env: (c) => (c.provider === "github" ? { GITHUB_TOKEN: c.token } : {}), skill: GITHUB_SKILL },
    gitlab: { env: (c) => (c.provider === "gitlab" ? { GITLAB_TOKEN: c.token, GITLAB_URL: c.url } : {}), skill: GITLAB_SKILL },
    sentry: { env: (c) => (c.provider === "sentry" ? { SENTRY_TOKEN: c.token, SENTRY_URL: c.url, SENTRY_ORG: c.org ?? "" } : {}), skill: SENTRY_SKILL },
    redmine: { env: (c) => (c.provider === "redmine" ? { REDMINE_URL: c.url, REDMINE_API_KEY: c.apiKey } : {}), skill: REDMINE_SKILL },
    outline: { env: (c) => (c.provider === "outline" ? { OUTLINE_URL: c.url, OUTLINE_API_KEY: c.apiKey } : {}), skill: OUTLINE_SKILL },
    imap: {
        env: (c) => (c.provider === "imap" ? { IMAP_HOST: c.host, IMAP_PORT: String(c.port), IMAP_USERNAME: c.username, IMAP_PASSWORD: c.password } : {}),
        skill: IMAP_SKILL,
    },
    signoz: { env: (c) => (c.provider === "signoz" ? { SIGNOZ_URL: c.url, SIGNOZ_API_KEY: c.apiKey } : {}), skill: SIGNOZ_SKILL },
} satisfies Record<CliConfig["provider"], CliProvider>;
