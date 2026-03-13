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
2. Starts a `pi --mode rpc` child process with its own working directory
3. Routes all thread messages to the child via stdin JSONL
4. Routes child output back to the thread

```
Master pi (interactive, runs pi-relay)
├── Discord client (single connection)
│   ├── #channel messages  →  master pi session
│   ├── thread-1 messages  →  RPC child A (stdin/stdout)
│   ├── thread-2 messages  →  RPC child B (stdin/stdout)
│   └── thread-3 messages  →  RPC child C (stdin/stdout)
│
├── RPC Child A: pi --mode rpc --cwd /project-a
├── RPC Child B: pi --mode rpc --cwd /project-b
└── RPC Child C: pi --mode rpc --cwd /project-c
```

Children die when the master restarts — no session persistence.

### Stream coalescing

Discord rate-limits message sends and edits. Instead of sending every text delta as a new message, the `StreamCoalescer` buffers streaming output and periodically edits a single Discord message in place (~800ms intervals). When the message nears Discord's 2000-char limit, it finalizes the current message and starts a new one. On turn end, any remaining buffer is flushed.

This applies to both the master session and all RPC children.

### Extension UI forwarding

RPC children may trigger interactive prompts (confirm, select, input, editor) that normally appear in the TUI. Since children have no TUI, these are forwarded to Discord:

- **confirm** → "Reply `yes` or `no`"
- **select** → numbered list, "Reply with a number"
- **input / editor** → "Reply with your text, or `/cancel`"

The child is paused until the Discord user responds. Any message in the thread while a UI prompt is pending is treated as the response.

### Proxy support

Discord connections (both WebSocket gateway and REST API) can be routed through HTTP/HTTPS/SOCKS proxies. The `proxy` config option patches both `undici` (used by `@discordjs/rest`) and `ws` (used by `@discordjs/ws`) before Discord.js is loaded.

## Modules

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entry — registers events, tools, commands; routes messages between Discord and pi |
| `src/discord.ts` | Discord client — connect, send, edit, typing, threads, image attachments |
| `src/rpc-child.ts` | RPC child process wrapper — spawn, JSONL protocol, event routing, Extension UI |
| `src/stream.ts` | `StreamCoalescer` — batches streaming text into Discord message edits |
| `src/formatter.ts` | Format messages between pi and Discord (tool call summaries, message splitting) |
| `src/config.ts` | Load and validate config from YAML |
| `src/proxy.ts` | Patch undici/ws for proxy support |
| `src/types.ts` | Shared type definitions |

## Install

```bash
pi install https://github.com/nicehiro/pi-relay
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/nicehiro/pi-relay"]
}
```

## Setup

1. Create a Discord bot and invite it to your server with `Send Messages`, `Read Message History`, `View Channels`, and `Create Public Threads` permissions.

2. Create the config at `~/.pi/agent/relay.yaml`:

```yaml
discord:
  token: "BOT_TOKEN"       # or set env DISCORD_BOT_TOKEN

machine:
  name: "workstation"

channels:
  - "123456789012345678"    # channel IDs this machine responds to

auth:
  users: []                 # Discord user IDs allowed (empty = all)

proxy: "socks5://127.0.0.1:1080"  # optional, or set HTTPS_PROXY env
```

## Usage

### Commands

| Command | Description |
|---|---|
| `/relay` or `/relay status` | Connection status, machine name, channels, active child sessions |
| `/relay reconnect` | Reconnect to Discord (kills all child sessions) |
| `/relay disconnect` | Disconnect from Discord |

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
