# pi-relay

A [pi](https://github.com/nicehiro/pi-coding-agent) extension that bridges Discord and pi. Each machine runs its own instance, owns its Discord channel(s), and connects independently — no hub or routing layer.

```
Machine A                    Machine B
┌──────────────────┐        ┌──────────────────┐
│ pi               │        │ pi               │
│  └─ pi-relay     │        │  └─ pi-relay     │
│     #workstation │        │     #hpc-cluster │
└────────┬─────────┘        └────────┬─────────┘
         │                           │
         ▼                           ▼
   ┌─────────────────────────────────────┐
   │         Discord Gateway             │
   └─────────────────────────────────────┘
```

## Features

- **Discord ↔ pi**: Messages in configured channels are forwarded to pi; responses stream back with coalesced chunking
- **Spawned sessions**: `spawn_session` tool creates Discord threads, each backed by an independent `pi --mode rpc` child process
- **Image support**: Discord image attachments are passed to pi; image tool results are uploaded back
- **Push notifications**: `discord_send` tool lets pi proactively message Discord
- **Extension UI forwarding**: Confirm/select/input dialogs from child sessions are forwarded to Discord threads
- **Proxy support**: Route Discord connections through HTTP/HTTPS/SOCKS proxies
- **Multi-turn**: Typing indicators persist across tool calls until the full response is complete
- **Per-machine isolation**: Each instance filters to its own channel IDs

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
| `/relay` or `/relay status` | Show connection status, machine name, channels, active sessions |
| `/relay reconnect` | Reconnect to Discord |
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

Creates a thread in the channel, starts a `pi --mode rpc` child process in the given directory, and routes all thread messages to that session. The child session has full tool access and forwards Extension UI prompts (confirmations, selections, text input) back to the thread for the user to respond to.

## License

MIT
