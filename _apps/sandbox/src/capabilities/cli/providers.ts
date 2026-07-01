import type { CliConfig } from "@intentic/sandbox-contract";

// The curated seam for CLI-tool integrations: each provider maps its manifest config to (1) the env vars the
// agent's shell needs (injected per turn by cliEnvOf) and (2) the SKILL.md cheatsheet dropped into the
// workspace's .claude/skills/<id> so the agent knows the tool exists and how to call it. Adding a provider is
// one entry here plus a CliConfigSchema variant — no new capability plumbing.
export interface CliProvider {
    readonly env: (config: CliConfig) => Record<string, string>;
    readonly skill: string;
}

// Discord has no official CLI, so the agent talks to Discord's REST API directly with curl + jq (both present
// in the sandbox image). The bot token rides in $DISCORD_BOT_TOKEN.
const DISCORD_SKILL = `---
name: discord
description: Read and post in the connected Discord server via the Discord REST API. Use when the user asks to send a Discord message, list channels/servers, or read recent messages.
---

# Discord (connected)

Authenticated with a bot token in \`$DISCORD_BOT_TOKEN\`. Talk to Discord's REST API with \`curl\`.
Base URL: \`https://discord.com/api/v10\` — Auth header: \`-H "Authorization: Bot $DISCORD_BOT_TOKEN"\`.

- List the bot's servers:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me/guilds | jq '.[] | {id, name}'\`
- List channels in a server:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/guilds/<GUILD_ID>/channels | jq '.[] | {id, name, type}'\`
- Read recent messages:
  \`curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" "https://discord.com/api/v10/channels/<CHANNEL_ID>/messages?limit=20" | jq '.[] | {author: .author.username, content}'\`
- Send a message:
  \`curl -s -X POST -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d '{"content":"hello"}' https://discord.com/api/v10/channels/<CHANNEL_ID>/messages\`

Notes: the bot must be invited to the server with the needed permissions/intents. Get IDs from the list commands above.
`;

export const cliProviders = {
    discord: {
        env: (config) => (config.provider === "discord" ? { DISCORD_BOT_TOKEN: config.botToken } : {}),
        skill: DISCORD_SKILL,
    },
} satisfies Record<CliConfig["provider"], CliProvider>;
