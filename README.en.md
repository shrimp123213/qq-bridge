# Discord ↔ DeepSeek Harness Bridge (discord-bridge)

> This bridge connects Discord messages to DeepSeek Harness (DSH) agents. Each Discord direct message and each server channel becomes a DSH conversation. The bridge sends agent replies (and agent questions and tool approvals) back to Discord.

> ⚠️ **Current release `v0.2.1-r1`. Target: DSH 0.2.1-rc.2** (DSH 0.2.0-rc.2 is also compatible; run `npm run verify:adaptation` to check your local DSH install). The bridge uses the persistent local signing key to **make the session cookie offline**. It uses slash RPC endpoints and the `/api/remote.mux` event stream. DSH `0.1.2-alpha.1` added this protocol generation. It is not compatible with the older dot-endpoint protocol. Since DSH 0.1.7, agent presets are `@deepseek-ai/dsh-agent-preset` Cordis rows (DSH no longer uses the `~/.dsh/.agent-presets/` directory).

The Chinese README ([README.md](README.md)) has the full guide.
The documentation index (one line for each document, with "still current?" notes) is **[docs/README.md](docs/README.md)**.
The folder layout and the script-naming rules are in **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**.

## Architecture

```
Discord messages ──► Discord Gateway (discord.js bot) ──► discord-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                               ▲                      │
                                                               └── agent replies / questions / approvals ┘
```

- **Discord side**: a `discord.js` v14 bot client (it reconnects automatically). All Discord input and output goes through the adapter `src/platform/discord.js`. `bridge.js` does not use discord.js directly.
  - A server text channel (or thread) becomes the conversation `group:<channel id>`. A direct message becomes `private:<user id>`.
  - The bridge ignores messages from other bots and from webhooks.
  - Outgoing messages ping only the one user that the bridge selects as the mention target. The bridge does not ping `@everyone`, roles or other `<@id>` text.
- **DSH side**: the protocol that DSH 0.1.2 added, checked again on 0.2.1-rc.2. The bridge makes a session cookie from the persistent local signing key, calls `/api/<namespace>/<method>` slash RPC, and reads the `/api/remote.mux` + `session/follow` event stream. The bridge sets the model of each session with `session.selectModel` from `dsh.model` in `config.json` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: two bundled MCP servers.
  - `discord` (`src/mcp-discord-safe.js`): a restricted Discord tool set (`chat_get_group_members`, `chat_send_group_message`, `chat_send_private_message`, `chat_reply`, and in `reserved2` the full simulation tool set). Send tools always check the whitelist. The MCP server does not connect to Discord. All actions go through the local bridge API, with the same whitelist and rate limits.
  - `web-search-safe` (`src/mcp-web-search-safe.js`): read-only `web_search` / `web_fetch` with SSRF protection.
- **Console**: a local web console at `http://127.0.0.1:3100`. It has ten task pages (Overview, Sessions & Approvals, Persona, Social v2, Social v1, Slang, Usage & Cost, Access & Security, Operations, Tool Reference), a feature search and a **light / dark theme**. Use it to change the mode, roles, whitelist and admin settings, slang and memory. The Overview page shows the Discord connection status (connected, gateway ping, last event). The **Usage & Cost** page shows token use and its price in CNY, for each channel, each direct message and each turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges Discord channel messages and direct messages to DSH agent sessions.
- Social simulation mode ("simulated group member") with idle / active / probing / exiting states.
- Space-based message splitting for natural multi-message replies.
- Whitelist and blacklist access control. The default is fail-closed.
- A sensitive-text audit stops paths and credentials from going to Discord.
- MCP tools to read members, send messages and reply to a message. In `reserved2`, the agent has the full simulation tool set.
- Slang and internet-expression learning, with human confirmation.
- A small memory system for active topics, pending thoughts and member impressions.

## Requirements

- Node.js >= 22.13
- A running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- A Discord bot (Developer Portal → Applications → Bot):
  - Turn on **Message Content Intent** (required). Turn on **Server Members Intent** only if you set `discord.guildMembersIntent` to `true`.
  - Invite the bot to your server (OAuth2 URL Generator, scope `bot`). Give it these permissions in the target channels: View Channel, Send Messages, Read Message History, Attach Files.

## Quick Start

```bash
npm install
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL. Default: `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token. **Usually keep this empty**: then the bridge makes the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`. If you set a value, the bridge uses it first |
| `dsh.authHeader` / `dsh.authPrefix` | Old fields, kept for compatibility. The current path uses cookie auth and does not send this header |
| `discord.token` | The Discord bot token. If it is empty, the bridge starts but does not connect to Discord |
| `discord.guildMembersIntent` | Default `false`. If `true`, the bridge asks for Server Members Intent to get full member lists |
| `ownerId` | The administrator's Discord **user id** |
| `allow.groups` / `allow.private` | Whitelist: **channel ids** in `allow.groups`, **user ids** in `allow.private` |
| `consolePort` | Local console port. Default: `3100` |

Discord ids have 17 to 20 digits. They are larger than the JavaScript safe-integer limit. **Write them as strings** in `config.json`.

Install the DSH side once on each machine, then restart DSH:

```bash
node scripts/setup-dsh.mjs
```

This script installs:

- the `discord-agent-presets` bundle. It makes the two `@deepseek-ai/dsh-agent-preset` rows (`dc-chat`, `dc-chat-v2`) and the shared `discord-tool-restrict` safety guard
- the MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `discord-mode-console` and `discord-agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- the default DSH mode `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

Start the bridge:

```bash
npm start
```

On Windows, you can double-click `start.bat` (guard mode with automatic restart). When the log shows `Discord 已连接：<bot name>`, the bot is online.

## Security Notes

- The repository never contains `config.json` or `state/`. It has only `config.example.json`. `npm run harden-acl` limits both to the owner / SYSTEM / Administrators.
- MCP send tools always check the whitelist.
- The audit layer removes local paths, credentials, tokens and other sensitive patterns from outgoing text.
- Simulation sessions get **no local execution tools**. The `discord-tool-restrict` row of the preset removes them from the tool schema at registration time. A runtime allowlist refuses all tools outside the `mcp__discord__` and `mcp__web-search-safe__` namespaces (`npm run scan:tool-names` checks this list against the installed DSH).
- If you do not set a console token, the console makes one.

## Repository Layout

```
discord-bridge/
  config.example.json   # sanitized config template (the real config.json is not in the repository)
  docs/
    README.md           # documentation index
    FOLDER_MAP.md       # folder layout and scripts/ naming rules
    guides/             # user and operator guides: DSH_SETUP, TOKEN_USAGE_CONSOLE, CONSOLE-UI-TESTING, PRIVACY, SECURITY_BASELINE
  dsh/agent-presets/    # dc-chat / dc-chat-v2 DSH agent preset templates
  plugins/discord-agent-presets  # DSH bundle: makes the preset rows + the shared tool guard
  plugins/discord-mode-console   # DSH plugin: adds the discord-mode settings namespace
  src/                  # bridge core, Discord adapter (src/platform/discord.js) and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images
  scripts/              # tests and helper scripts
  state/                # runtime data (not in the repository)
```

## Testing

`npm run test:audit` runs isolated regression tests. It does not use production credentials, DSH or Discord.

```bash
npm run test:discord    # Discord adapter with a fake client (no network)
npm run self-test       # DSH-side link test, no Discord required
npm run test-wait
npm run test-vision
npm run test-slang
```

## Compliance

Read and obey the [Discord Developer Terms of Service](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service), the [Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) and the rules of each server. This project sends Discord messages to a large language model and lets the model speak as the bot. Tell the server members about this before you use it.
