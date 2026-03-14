# pi-relay

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that bridges Discord and pi. Each machine runs its own instance, owns its Discord channel(s), and connects independently — no hub or routing layer.

## Design

### Per-machine isolation

Multiple machines can share the same Discord bot token. Each pi-relay instance is configured with specific channel IDs and only responds to messages in those channels. Discord's gateway delivers all events to every connection, but each instance filters to its own channels and ignores everything else.

```
Machine A (workstation)           Machine B (HPC cluster)
┌──────────────────────┐         ┌──────────────────────┐
│ pi (interactive)     │         │ pi (interactive)     │
│  └─ pi-relay         │         │  └─ pi-relay         │
│     #workstation     │         │     #hpc-cluster     │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           ▼                                ▼
     ┌────────────────────────────────────────────┐
     │            Discord Gateway                  │
     └────────────────────────────────────────────┘
```

### Master and spawned sessions

The master pi session runs interactively (TUI) and owns all Discord I/O. Messages in configured channels are forwarded to the master session directly.

When the master spawns a child session (via the `spawn_session` tool), it:

1. Creates a Discord thread in the channel
2. Creates an in-process `AgentSession` via the pi SDK with its own working directory
3. Routes all thread messages to the child session
4. Subscribes to child events and routes output back to the thread

```
Master pi (interactive, runs pi-relay)
├── Discord client (single connection)
│   ├── #channel messages  →  master pi session
│   ├── thread-1 messages  →  AgentSession A (cwd: /project-a)
│   ├── thread-2 messages  →  AgentSession B (cwd: /project-b)
│   └── thread-3 messages  →  AgentSession C (cwd: /project-c)
│
├── AgentSession A (in-memory, /project-a)
├── AgentSession B (in-memory, /project-b)
└── AgentSession C (in-memory, /project-c)
```

Children use in-memory sessions — no persistence across master restarts.

### Stream coalescing

Discord rate-limits message sends and edits. Instead of sending every text delta as a new message, the `StreamCoalescer` buffers streaming output and periodically edits a single Discord message in place (~800ms intervals). When the message nears Discord's 2000-char limit, it finalizes the current message and starts a new one. On turn end, any remaining buffer is flushed.

This applies to both the master session and all child sessions.

### Child sessions

When the master spawns a child session (via the `spawn_session` tool), it uses the pi SDK's `createAgentSession()` to create an in-process `AgentSession` — no subprocess. The child session:

- Loads global extensions (except pi-relay itself, to prevent recursion)
- Uses `SessionManager.inMemory()` (no session persistence)
- Subscribes to typed `AgentSessionEvent`s and routes them to Discord
- Surfaces auto-compaction and auto-retry events as Discord messages

### Discord interaction

Users can control sessions from Discord without pi TUI access:

- **Slash commands** (`/pi status`, `/pi stop`) — registered via Discord's REST API on connect when `applicationId` is configured. `/pi stop` kills the RPC child in the current thread.
- **Cancel button** — tool call summaries in spawned threads include a Cancel button. Clicking it kills the child immediately. The button is removed when the agent finishes its turn.

### Message context

Incoming Discord messages are formatted with metadata before being forwarded to pi:

- **Username**: `[Discord @username]: message`
- **Reply context**: when a user replies to a specific message, the referenced message's author and content (truncated to 200 chars) are included: `[replying to author: snippet]`
- **Images**: Discord attachments are fetched and passed as base64

### Config validation

Config is validated on load with structured diagnostics. Errors (missing token, missing channels) prevent startup. Warnings are logged to console:

- Invalid-looking Discord snowflake IDs
- Missing machine name
- No auth users configured (open access)
- Missing `applicationId` (slash commands won't register)

### Proxy support

Discord connections (both WebSocket gateway and REST API) can be routed through HTTP/HTTPS/SOCKS proxies. The `proxy` config option patches both `undici` (used by `@discordjs/rest`) and `ws` (used by `@discordjs/ws`) before Discord.js is loaded.

## Modules

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entry — registers events, tools, commands; routes messages between Discord and pi |
| `src/discord.ts` | Discord client — connect, send, edit, typing, threads, slash commands, cancel buttons, image attachments |
| `src/session-child.ts` | Child session via SDK `AgentSession` — event routing, stream coalescing, compaction/retry notifications |
| `src/stream.ts` | `StreamCoalescer` — batches streaming text into Discord message edits |
| `src/formatter.ts` | Format messages between pi and Discord (tool call summaries, message splitting) |
| `src/config.ts` | Load and validate config from YAML with structured diagnostics |
| `src/proxy.ts` | Patch undici/ws for proxy support |
| `src/types.ts` | Shared type definitions |

## Install

```bash
pi install npm:pi-relay
```

Or from git:

```bash
pi install https://github.com/nicehiro/pi-relay
```

## Setup

1. Create a Discord bot and invite it to your server with `Send Messages`, `Read Message History`, `View Channels`, and `Create Public Threads` permissions.

2. Create the config at `~/.pi/agent/relay.yaml`:

```yaml
discord:
  token: "BOT_TOKEN"              # or set env DISCORD_BOT_TOKEN
  applicationId: "APP_ID"         # or set env DISCORD_APPLICATION_ID (for slash commands)

machine:
  name: "workstation"

channels:
  - "123456789012345678"          # channel IDs this machine responds to

auth:
  users: []                       # Discord user IDs allowed (empty = all)

proxy: "socks5://127.0.0.1:1080"  # optional, or set HTTPS_PROXY env
```

## Usage

### Pi commands

| Command | Description |
|---|---|
| `/relay` or `/relay status` | Connection status, machine name, channels, active child sessions |
| `/relay reconnect` | Reconnect to Discord (kills all child sessions) |
| `/relay disconnect` | Disconnect from Discord |

### Discord slash commands

Requires `applicationId` in config. Registered automatically on connect.

| Command | Description |
|---|---|
| `/pi status` | Show pi-relay status (ephemeral) |
| `/pi stop` | Stop the running session in the current thread |

### Cancel button

Tool call summaries in spawned threads include a **Cancel** button. Clicking it kills the RPC child session immediately.

### Tools

**`discord_send`** — Send a message to the first configured channel:
```
discord_send({ message: "Training complete!" })
```

**`spawn_session`** — Spawn a new pi session in a Discord thread:
```
spawn_session({ cwd: "/path/to/project", name: "my-task", task: "fix the tests" })
```

## License

MIT
