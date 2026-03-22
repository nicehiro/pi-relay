# pi-relay

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that bridges Discord and pi. Each machine runs its own instance, owns its Discord channel(s), and connects independently — no hub or routing layer.

## Install

```bash
pi install git:https://github.com/nicehiro/pi-relay
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

3. Start pi and connect with `/relay`.

## Usage

### Connecting

pi-relay does **not** auto-connect on startup. Use `/relay` or `/relay reconnect` in the pi TUI to connect. Once connected, Discord-triggered reloads (`/pi reload`) will auto-reconnect.

### Pi TUI commands

| Command | Description |
|---|---|
| `/relay` or `/relay status` | Connect (if needed) and show status |
| `/relay reconnect` | Reconnect to Discord |
| `/relay disconnect` | Disconnect from Discord |
| `/relay reload` | Reload all pi extensions |

### Discord slash commands

Requires `applicationId` in config. Registered automatically on connect.

| Command | Description |
|---|---|
| `/pi status` | Show connection status, machine name, active sessions |
| `/pi stop` | Stop the running session in the current thread |
| `/pi reload` | Reload pi extensions and auto-reconnect |

### Spawning sessions

Ask pi to spawn a child session from Discord, and it will create a thread with an independent `AgentSession`:

```
spawn_session({ cwd: "/path/to/project", name: "my-task", task: "fix the tests" })
```

Each thread gets its own working directory, conversation history, and tools. Sessions persist across reloads — active threads are resumed automatically on reconnect.

### Approval buttons

Child sessions have a Discord-backed UI context. When extensions (like [safe-git](https://github.com/qualisero/rhubarb-pi)) need user approval (e.g., for `git push`), they show ✅/❌ buttons in the Discord thread instead of blocking silently. Buttons time out after 60 seconds.

### Sending messages from pi

```
discord_send({ message: "Training complete!" })
```

Sends to the first configured channel.

## Design

### Per-machine isolation

Multiple machines share a single Discord bot token. Each pi-relay instance filters to its configured channel IDs and ignores everything else.

```
Machine A (workstation)           Machine B (HPC cluster)
┌──────────────────────┐         ┌──────────────────────┐
│ pi                   │         │ pi                   │
│  └─ pi-relay         │         │  └─ pi-relay         │
│     #workstation     │         │     #hpc-cluster     │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           ▼                                ▼
     ┌────────────────────────────────────────────┐
     │            Discord Gateway                  │
     └────────────────────────────────────────────┘
```

### Master and child sessions

The master pi session runs in the TUI and owns the Discord connection. Channel messages go to the master session. Thread messages go to child `AgentSession`s, each with their own working directory and context.

```
Master pi (TUI, runs pi-relay)
├── Discord client
│   ├── #channel messages  →  master session
│   ├── thread-1 messages  →  AgentSession A (/project-a)
│   └── thread-2 messages  →  AgentSession B (/project-b)
├── AgentSession A
└── AgentSession B
```

Child sessions:
- Use the pi SDK's `createAgentSession()` in-process (no subprocess)
- Load global extensions (except pi-relay, to prevent recursion)
- Persist conversation via file-backed `SessionManager` — survive reloads
- Have a Discord-backed `ExtensionUIContext` for approval dialogs
- Surface auto-compaction, auto-retry, and tool progress as Discord messages

### Stream coalescing

Instead of flooding Discord with every text delta, the `StreamCoalescer` buffers output and edits a single message in place (~800ms intervals). When nearing Discord's 2000-char limit, it finalizes the message and starts a new one.

### Message formatting

- Incoming: `[Discord @username]: message` with optional `[replying to author: snippet]` context
- Images: Discord attachments fetched and passed as base64
- Tool calls: summarized as `🔧 bash ($ command)`, `🔧 edit (path)`, etc.
- Tables: converted to code blocks (Discord doesn't render markdown tables)
- Long messages: split at paragraph/line/word boundaries to stay under 2000 chars

### Proxy support

Discord connections (WebSocket + REST) can route through HTTP/HTTPS/SOCKS proxies via the `proxy` config option.

## Modules

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entry — events, tools, commands, message routing |
| `src/discord.ts` | Discord client — connect, send, threads, slash commands, approval buttons |
| `src/discord-ui.ts` | Discord-backed `ExtensionUIContext` for child session approvals |
| `src/session-child.ts` | Child session lifecycle — `AgentSession` creation, event routing, streaming |
| `src/stream.ts` | `StreamCoalescer` — batches streaming text into Discord message edits |
| `src/formatter.ts` | Format messages between pi ↔ Discord |
| `src/config.ts` | Load and validate config from YAML |
| `src/proxy.ts` | Patch undici/ws for proxy support |
| `src/types.ts` | Shared type definitions |

## License

MIT
