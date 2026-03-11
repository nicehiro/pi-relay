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

## Setup

1. Create a Discord bot and invite it to your server with `Send Messages`, `Read Message History`, and `View Channels` permissions.

2. Clone and install:
   ```bash
   git clone https://github.com/nicehiro/pi-relay.git
   cd pi-relay
   npm install
   ```

3. Copy and edit the config:
   ```bash
   cp config.example.yaml config.yaml
   ```
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

4. Add to your pi config (`~/.pi/agent/extensions`):
   ```
   /path/to/pi-relay
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
