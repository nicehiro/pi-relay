# pi-relay

Discord ↔ pi bridge extension. See PLAN.md for full design.

## Prior Art: OpenClaw

Investigated [openclaw/openclaw](https://github.com/openclaw/openclaw) — a multi-channel AI gateway with a plugin SDK supporting Discord, Telegram, WhatsApp, Slack, etc. Their Discord extension lives in `extensions/discord/` with clean separation: `channel.ts` (ChannelPlugin), `subagent-hooks.ts` (session lifecycle), `runtime.ts` (shared state), `index.ts` (registration).

### Patterns to adopt

- **Streaming coalesce**: Buffer streamed output before flushing to Discord (`minChars: 1500, idleMs: 1000`). Avoids rate limits and message flickering.
- **Thread binding lifecycle**: `subagent_spawning` → create thread + bind to session, `subagent_ended` → unbind + optional farewell, `subagent_delivery_target` → route messages back to correct thread. Use this model for Phase 5.
- **Outbound target normalization**: `resolveTarget` normalizes channel/thread targets before sending. Keeps send logic clean.
- **Runtime store**: `getRuntime()`/`setRuntime()` pair for shared state across modules. Avoids passing context everywhere.
- **Permission probing at startup**: Audit that the bot has `SEND_MESSAGES` and `VIEW_CHANNEL` on configured channels. Surface in `/relay status`.

### Not adopting (over-engineering for us)

- Plugin SDK / config schema system — we're one extension, not a framework
- Multi-account support — one token per machine
- Poll/reaction abstractions
- DM policy engine — simple user ID allowlist suffices
