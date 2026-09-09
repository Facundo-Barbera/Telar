# Execution lifecycle contract

Implementation started 2026-09-09 following approval of the engine revision plan.
The revision aligns session Stop, gives embedded execution a direct port, and
adds transactional execution storage and an opt-in OpenCode adapter.

## Command ownership

| Command | Scope | Result |
|---|---|---|
| Session Stop | Selected session's active, queued, held, undelivered steering and background work | Terminalize pending execution; cancel provider work; retain transcript |
| Stop one turn | Explicit run ID | End that run; preserve unrelated queued/background work |
| Stop background tasks | Background task records of selected session | Stop tasks without cancelling foreground work |
| Project Run stop | Explicit project service | Owned by the project service subsystem; never inferred from session Stop |
| Deprecated Pause | Compatibility alias for session Stop | No new pause latch |

The session command is `POST /stop {"scope":"session"}` through both engine
and web APIs. A request with a run ID and session scope is invalid. The legacy
unscoped endpoint remains compatible; clients must use explicit session scope
for the composer Stop action. Withdrawing a queued message still names its run.

## Transition table

| State at session Stop | Stored state afterward | History |
|---|---|---|
| Queued, including legacy held | Stopped | Preserve input and attachments; remove hold |
| Claimed / running | Stopped | Preserve output prefix; close unfinished items/requests |
| Steering, not acknowledged | Stopped | Preserve user message; do not requeue |
| Steered, acknowledged | Steered | It was delivered; preserve attribution |
| Legacy ambiguous | Stopped | Do not imply external effects were undone |
| Completed / failed / stopped | Unchanged | Retain original outcome |
| Live session background task | Stopped | Queue provider task cancellation; fence late reports |

Stop is a boundary over work already accepted. A new message accepted afterward
may run immediately with the same provider history. Repeating Stop with no new
work is a no-op. A new Stop received after new work begins stops that new work;
command-ID replay suppression is a later persistence milestone, not a promise
of the current endpoint.

## Fencing and identity

Current execution identity is the session ID, run ID, claim token and worker
registration identity. The store writes terminal queue state before the worker
receives cancellation. Claim start, steering acknowledgment, observation and
completion handlers reject incompatible terminal state. Task projection folding
preserves the first terminal outcome even if later provider progress arrives.

Session Stop clears legacy pause metadata only after terminalizing the held
backlog. Startup also migrates old pending records without submitting them.
There is no implicit replay and no Resume required for the next new message.

Embedded lifecycle commands now call the shared command handlers directly.
External workers retain HTTP registration, leases, and claim fencing. SQLite
commits execution projections, journal events, and command receipts together;
provider calls and notifications run outside that transaction. Run IDs remain
distinct from provider session IDs and OpenCode's deterministic message IDs.

## Tests and remaining limits

State regressions cover foreground and idle-background Stop, late task reports,
other-session isolation, repeated Stop, preserved held-message text, and a fresh
message after Stop. Existing tests cover claim/start and steering races, late
completion, and restart migration. A daemon/worker test verifies actual provider
`stopTask` invocation as well as foreground abort and no backlog execution.
Swift networking tests distinguish session Stop from withdrawal of one message.

Task-stop delivery is persisted, routed to the owning worker, and retried until
acknowledged. Failed provider kills are not acknowledged. Retired registrations
cannot receive another worker's deliveries. State marking still does not prove
that an unreachable external process stopped.

The Stop HTTP body may include `commandId`. Replaying the same ID returns its
stored result without stopping a subsequently submitted message. Web and Swift
mint a new ID per user gesture. JSON compatibility mode cannot provide durable
receipts; migrated homes cannot silently reopen that mode.

OpenCode is disabled initially and paired with SDK/CLI 1.18.30. It queues follow-ups,
grants native permissions once, reconciles snapshots after dropped SSE, and never
blindly repeats an uncertain prompt. Background-task stop and manual compaction
are not advertised for that adapter. See the implementation report for validation.
