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

- **Discord → pi**: Messages in configured channels are forwarded to pi as user messages
- **pi → Discord**: Assistant responses stream back with coalesced chunking (avoids rate limits)
- **Image support**: Discord image attachments are passed to pi; image tool results are uploaded back
- **Push notifications**: `discord_send` tool lets pi proactively message Discord
- **Multi-turn**: Typing indicators persist across tool calls until the full response is complete
- **Per-machine isolation**: Each instance filters to its own channel IDs

## Install

```bash
pi install https://github.com/nicehiro/pi-relay
```

Or add it to `~/.pi/agent/settings.json` manually:

```json
{
  "packages": ["git:github.com/nicehiro/pi-relay"]
}
```

## Setup

1. Create a Discord bot and invite it to your server with `Send Messages`, `Read Message History`, and `View Channels` permissions.

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
   ```

## Usage

### Commands

| Command | Description |
|---|---|
| `/relay` or `/relay status` | Show connection status, machine name, channels |
| `/relay reconnect` | Reconnect to Discord |
| `/relay disconnect` | Disconnect from Discord |

### Tools

The `discord_send` tool is available to the LLM:
```
discord_send({ message: "Training complete!" })
```

Sends to the first configured channel. Supports markdown.

## License

MIT
