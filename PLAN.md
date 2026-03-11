# pi-relay

A pi extension that connects each machine's pi instance to Discord independently. No hub, no routing — each machine owns its channel(s).

## Architecture

```
Machine A (workstation)              Machine B (hpc)
┌─────────────────────────┐         ┌─────────────────────────┐
│ pi                      │         │ pi                      │
│  └─ pi-relay extension  │         │  └─ pi-relay extension  │
│      channels:          │         │      channels:          │
│        #workstation     │         │        #hpc-cluster     │
│      connects to ───────┼──┐      │      connects to ───────┼──┐
└─────────────────────────┘  │      └─────────────────────────┘  │
                             │                                    │
                             ▼                                    ▼
                      ┌─────────────────────────────────────────────┐
                      │            Discord Gateway                  │
                      │  (both connections receive all events;      │
                      │   each filters to its own channels)         │
                      └─────────────────────────────────────────────┘
                                         ▲
Discord Server                           │
├── 📁 pi-machines                       │
│   ├── #workstation  ← Machine A only   │
│   ├── #hpc-cluster  ← Machine B only   │
│   └── #laptop       ← Machine C only   │
└── 📁 notifications                     │
    └── #alerts       ← any machine can push
```

### Why This Works

Discord allows multiple gateway connections with the same bot token. Each connection receives all events but the extension filters to only respond to its configured channels. Sending messages works from any number of instances.

Constraints (negligible for this use case):
- 1000 IDENTIFY calls / 24h shared across all connections
- `max_concurrency: 1` — stagger startup by a few seconds if connecting multiple machines simultaneously

## Config

`~/.pi/agent/extensions/pi-relay/config.yaml`:

```yaml
discord:
  token: "BOT_TOKEN"       # or omit to use env DISCORD_BOT_TOKEN

machine:
  name: "workstation"       # display name for this machine

channels:
  - "123456789012345678"    # channel IDs this machine responds to

notify:
  channel: "987654321098765432"  # channel for push notifications (optional)

auth:
  users: []                 # Discord user IDs allowed (empty = all)
  roles: []                 # Discord role names allowed (empty = all)
```

### Why channel IDs, not names?

Channel names aren't unique across guilds or even within a guild. IDs are unambiguous. The extension resolves display names from Discord at runtime.

## Message Flow

### Discord → Pi

1. User posts in `#workstation`
2. All connected pi-relay instances receive the `MessageCreate` event
3. Only the workstation's extension matches the channel ID → processes it
4. Others silently discard
5. Extension calls `pi.sendUserMessage("[Discord @username]: message content")`
6. Pi processes normally (tools, LLM, etc.)

### Pi → Discord (response)

1. `turn_end` event fires with assistant message
2. Extension extracts text + tool call summaries
3. Formats for Discord (markdown, code blocks, truncation)
4. Splits into ≤2000-char chunks
5. Sends to the originating channel (or thread)
6. Clears pending state only when no more tool calls remain (multi-turn support)

### Pi → Discord (push)

1. Pi calls the `discord_send` tool: `discord_send({ message: "Training done!" })`
2. Extension sends to the configured notify channel
3. Or to any channel ID specified in the tool call

## Extension Events

| Pi Event | Action |
|---|---|
| `session_start` | Load config, connect to Discord |
| `turn_start` | Send typing indicator to Discord channel |
| `turn_end` | Format + send response back to Discord |
| `session_shutdown` | Disconnect from Discord, cleanup |

## Registered Tools

### `discord_send`

Push messages from pi to Discord. Available for the LLM to call or for external use via pi's control socket.

```
discord_send({ message: "Training complete!", channel?: "channel_id" })
```

- If `channel` omitted, sends to configured `notify.channel`
- Supports markdown formatting

## Registered Commands

### `/relay`

```
/relay status       — show Discord connection status, channels, machine name
/relay connect      — reconnect to Discord
/relay disconnect   — disconnect from Discord
/relay config       — show current config
```

## Message Formatting

### Discord → Pi
```
[Discord @username]: message content
```

Images: Discord attachment URLs are fetched and passed to pi as base64 images.

### Pi → Discord

- Markdown passes through (Discord supports it natively)
- Code blocks preserved as-is
- Tool calls summarized: `🔧 bash ($ ls -la)`, `🔧 edit (path/to/file.ts)`
- Messages >2000 chars split at paragraph/line/word boundaries
- Images from tool results: attached as Discord file uploads

## Thread Strategy

**Phase 1**: All messages in the channel (simple, like pi-messenger-bridge).

**Phase 2** (later): Option to use Discord threads per pi session.
- `/relay thread` creates a new thread in the channel, starts a new pi session
- Messages in the thread go to that session
- Messages in the main channel go to the default session
- Thread title shows session info

## File Structure

```
pi-relay/
├── package.json
├── tsconfig.json
├── config.example.yaml
├── src/
│   ├── index.ts           # Extension entry: events, tool, command registration
│   ├── config.ts          # Load/validate config from YAML
│   ├── discord.ts         # Discord client: connect, send, receive, typing
│   ├── formatter.ts       # Format pi messages for Discord + vice versa
│   └── types.ts           # Shared types
└── dist/                  # Built output (gitignored)
```

## Reusable from pi-messenger-bridge

| What | Where | Adapt |
|---|---|---|
| `extractTextFromMessage()` | index.ts:95 | As-is |
| `hasToolCalls()` | index.ts:103 | As-is |
| `formatToolCalls()` | index.ts:110 | As-is |
| `splitMessage()` | index.ts:143 | Change limit from 4000 to 2000 (Discord limit) |
| `turn_end` handler pattern | index.ts:361 | Adapt: no transport manager, direct Discord send |
| `pendingRemoteChat` tracking | index.ts | Simplify: just track channel ID |
| Discord client setup + intents | discord.ts:50 | Adapt: add channel filtering |
| Message dedup | discord.ts | Reuse pattern |

## Dependencies

```json
{
  "dependencies": {
    "@mariozechner/pi-ai": "latest",
    "@mariozechner/pi-coding-agent": "latest",
    "discord.js": "^14.25.1",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0"
  }
}
```

Intentionally minimal — no Telegram/WhatsApp/Slack deps. Discord only.

## Phases

### Phase 1: Core (Discord ↔ Pi, single channel)

- [ ] Project scaffold (package.json, tsconfig, config)
- [ ] Config loading from YAML with env var fallback for token
- [ ] Discord client: connect with intents, channel filtering
- [ ] Incoming messages: channel filter → `pi.sendUserMessage()`
- [ ] `turn_start` → typing indicator
- [ ] `turn_end` → format + send response (with chunking)
- [ ] Multi-turn support (don't clear pending until no tool calls)
- [ ] `/relay status` command
- [ ] Basic error handling + reconnection

**Result**: Working Discord ↔ pi bridge on one machine, one channel.

### Phase 2: Push Notifications

- [ ] `discord_send` tool registration
- [ ] Notify channel config
- [ ] Support sending to arbitrary channel IDs
- [ ] Test: pi can proactively message Discord

**Result**: Pi can push messages to Discord (training done, errors, etc.)

### Phase 3: Auth & Multi-channel

- [ ] User ID / role-based auth
- [ ] Multiple channel IDs per machine
- [ ] `/relay connect` / `/relay disconnect` commands
- [ ] Status widget (optional, in pi TUI footer)

**Result**: Locked down, multi-channel per machine.

### Phase 4: Rich Media

- [ ] Discord image attachments → pi (fetch + base64)
- [ ] Pi image outputs → Discord file attachments
- [ ] File content sharing (large outputs as Discord file uploads)
- [ ] Embed formatting for structured outputs

**Result**: Full media support.

### Phase 5: Thread-per-session (optional)

- [ ] Create Discord thread per pi session
- [ ] Map threads to sessions
- [ ] `/relay thread` command
- [ ] Thread auto-naming from first message

**Result**: Organized multi-session support within a channel.
