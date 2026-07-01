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

export const cliProviders = {
    discord: {
        env: (config) => (config.provider === "discord" ? { DISCORD_BOT_TOKEN: config.botToken } : {}),
        skill: DISCORD_SKILL,
    },
} satisfies Record<CliConfig["provider"], CliProvider>;
