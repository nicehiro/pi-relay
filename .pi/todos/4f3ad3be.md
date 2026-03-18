{
  "id": "4f3ad3be",
  "title": "pi-relay Phase 3: Auth & multi-channel",
  "tags": [
    "pi-relay",
    "phase-3"
  ],
  "status": "closed",
  "created_at": "2026-03-11T05:42:22.963Z"
}

## Scope
Lock down who can use the bot. Support multiple channels per machine.

## Tasks
1. User ID allowlist check on incoming messages
2. Role-based auth (check member roles in guild)
3. Multiple channel IDs in config
4. `/relay connect` and `/relay disconnect` commands
5. Optional TUI status widget (footer showing Discord connection state)

## Depends on
- Phase 1 complete
