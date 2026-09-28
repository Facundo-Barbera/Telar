# Engine: traps and constraints

## Storage

- SQLite (the execution store) is the only journal backend. Old homes with JSON journals are imported once on open, and that importer stays.
- Writes go through `command(name, fn)`. Commands are re-entrant. Session rows are flushed only when the outermost command ends, and `afterCommit` callbacks run once, in order. Don't await inside a command: SQLite commands are synchronous. That is why `createSessionAsync`/`submitTurnAsync` prefetch git first and then run the synchronous command.
- Every in-memory cache has exactly one writer. Keep a cache in the module that writes it, or it goes stale.
- The hot paths are `appendEvent` (called once per streamed chunk), `writeQueue` and the heartbeat reads. Measure with the `bench:*` scripts before and after touching them.

## Turns

- A turn is accepted, then queued, claimed, running, and finally completed, failed or stopped. A claimed turn requeues after a restart instead of vanishing.
- Sequence numbers do not mean run order. `openProviderTurn` can open a turn from a background task while a lower-sequence turn is still queued. The cockpit therefore orders the transcript by `startedAt`, and puts turns that haven't started last.
- A message sent while a turn is running is **steered** into it and renders inside that turn.
- A turn ending fires, in this order: subscriptions, then held notifications, then delegation settling. Keep that order.

## Sessions talking to sessions

- Today: `sessions_send` with an intent (`task`, `report`, `result`, `blocker`), plus `sessions_subscribe` cohorts that deliver one notice when every member is done. A `task` links the child to the sender. Reports never open a turn. Blockers and parked requests interrupt.
- Planned (migration phase 6): `create` takes a mode, `child` (a sub-agent whose final message is its result, with one notice to the parent each time it stops) or `handoff` (the owner's session, with no link and no notices). The intents and cohorts go away.

## HTTP

- Routes are matched literal paths first, then patterns in declared order. `/v2/sessions/mcp`, `/live`, `/find` and `/activity` must beat the `sessions/:id` pattern.
- Streaming routes (`/sessions/stream`, `/run/stream`) own the raw response.
- Every interval started in `startEngine` must be cleared by `stopTimers()`, on close and on the error path.

## Agent tools

- `telarWall(caps)` is the single list of tools every provider gets. Claude receives them in-process through `toSdkTools`; Codex and OpenCode receive them over the per-run socket. Never register a toolkit anywhere else; the copies drift.
- Tool names are `mcp__telar__<prefix>_*`. Approvals and the read-only policy key on those names, so renaming a tool changes what gets approved.
