# Engine revision implementation and rollout

This implements the review approved on 2026-09-09. The installed application is not replaced by local packaging. The supported delivery path remains the signed nightly workflow.

## What changed

- Embedded execution uses a direct port into the same command handlers as external HTTP workers. A lost loopback transport can no longer retire the embedded executor. External registrations retain lease and claim fencing. Shutdown disposes every adapter used by the worker, including OpenCode.
- The provider contract no longer belongs to the Claude driver. The registry exposes explicit live-steering, compaction, and background-stop capabilities. Existing Claude/Codex implementations retain their protocols.
- Production engine startup selects SQLite WAL. Queue/session/item/request/task projections, events, subscriptions, task-stop intents, and command receipts share one transaction. Attachments, project configuration, and Spool files remain outside this migration. Idle read-only command polls do not generate receipt writes.
- Background Stop deliveries are durable, owner-specific, and acknowledged only after the provider handles them. Repeating a receipt-bearing Stop cannot cancel a message accepted after that Stop. Cancellation retains history and never replays queued work.
- Web session connections retain projection and cursor together across mounts, coalesce overlapping reads, and isolate hosts. Cockpit and Spool reads share the connection implementation; paging windows have separate cached projections. Offline snapshots retain folded text. Swift now understands streaming prefixes and their watermarks, skips reflected deltas, and rejects cancelled poll results. Text reveal is presentation-only, respects reduced motion, and flushes on completion. Failed turns explain that a new message continues the conversation.

## OpenCode boundary

OpenCode is an opt-in third provider. Enable its instance in Settings after selecting the supported binary. This adapter and `@opencode-ai/sdk` are paired with **1.18.30**; Settings and the server health handshake reject a different version with a specific explanation. The installed system CLI has not been upgraded by this work.

Each Telar session owns an authenticated loopback OpenCode server process group. Runtime MCP registrations carry that session's capability tokens; removed registrations disconnect on the next turn. Idle servers close after ten minutes. Shutdown or a failed run fences the owned process. The native provider session ID is recorded before prompt admission and preserved for the next turn.

SSE accelerates reads; snapshots determine progress. A lost prompt acknowledgment is reconciled by the exact deterministic upstream message ID. Unknown admission fails without replay. Native permissions and questions use separate engine requests; an approval grants `once`, including when the engine decision says `acceptForSession`. Follow-ups queue because this adapter does not support live steering. Manual compaction and detached background-task cancellation are not advertised. The existing Claude-only Spool/Warp tool gap is not silently claimed closed by adding OpenCode.

OpenCode uses its native CLI login. `OPENCODE_CONFIG_DIR` changes configuration, not credential isolation. Separate authenticated accounts are not promised by creating multiple config folders.

## Storage migration and recovery

The daemon acquires its exclusive home lock before opening or migrating execution storage. Import validates committed journal records and monotonic IDs, preserves a valid final record without its newline, and ignores only a torn final record. Original execution files are copied into `execution-json-backup`. The database becomes authoritative; a marker and incompatible legacy session headers prevent old binaries from reading stale JSON as current history. There is no dual write of authoritative execution state.

A failed database transaction invalidates derived in-memory caches. Notification delivery follows commit; it remains best-effort, and an interrupted delivery leaves a durable request marked unnotified. Git/worktree operations and attachments are not transactional database effects. SQLite does not make upstream provider admission exactly-once.

Prefer a forward repair. For an offline export, quit the engine using the home, then run:

```sh
bun apps/engine/scripts/export-execution.ts /absolute/engine-home /absolute/new-export-directory
```

The export refuses an existing destination and an actively locked engine home. It writes execution JSON and journals, including post-migration history. Attachments and other application data remain in the source home. To prepare a compatibility home, work on a separate complete copy of the stopped home, overlay the export, and remove SQLite files and the migration marker **only from that copy**. Use a build that understands all exported protocol records. Pre-OpenCode builds cannot be assumed to read OpenCode histories. Receipts do not survive conversion to JSON. Restoring only the original backup loses post-upgrade writes; retain the full current home and export first.

`TELAR_EXECUTION_STORE=json` is available for an unmigrated compatibility home. It is refused after migration. Library-level test daemons still default to JSON unless explicitly configured; production `main.ts` selects SQLite.

## Validation

- Engine: 1,864 passing / 3 skipped on the full run before the last additional conformance cases; subsequent targeted suites cover those additions and adapter disposal. The skips require a live Claude background-monitor environment.
- SQLite: atomic queue/event/receipt commit, rollback/cache invalidation, real SIGKILL during a transaction, import/backup/reopen, post-migration export, Stop receipt replay, and persistent owner-specific cancellation.
- OpenCode: real SDK fixture tests cover streaming, lost admission acknowledgment, permissions, questions, admission-time Stop, unknown admission, and terminal provider failure. `smoke-opencode.ts` ran the actual 1.18.30 CLI against an isolated local model fixture and completed a real turn without credentials or paid calls.
- Web: 1,516 passing. Shared-connection tests cover coalescing, host separation, retained state during an outage, a companion snapshot ahead of its tail, and the engine-generated fixture also decoded by Swift.
- iOS: 105 tests passing, including prefix overlap on remount and the shared OpenCode snapshot. Simulator build succeeded.
- Engine client: 68 passing. Desktop unit tests: 188 passing / 2 skipped. Typecheck passes; the existing core test-tree ceiling remains 264. Lint has no errors and 12 pre-existing warnings.
- Packaged Electron/SQLite smoke and final CI status are release gates recorded in the PR. Local package output is not an installation or nightly publication.

These checks establish protocol behavior and crash recovery in isolated homes. They do not prove that the original incident had only one cause, nor do they eliminate upstream Codex network reconnects. Real-account provider behavior and the user's installed nightly must still be observed after rollout.
