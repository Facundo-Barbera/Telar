# Review — adversarial seams

**Lens** (configured `finalize_reviewers[1]`): construct two units one level down that each obey every AD to the letter yet still build incompatibly. Every pair found is a hole to close.

**Verdict:** CHANGES REQUIRED — 6 constructible incompatible pairs, 2 of them contradictions internal to the spine.

---

## A1 — Two owners of `spend.ndjson` (critical, internal contradiction)

**The pair.** Ultra's epic implements AD-18 by appending its run spend to the root `spend.ndjson`. The looms epic does the same for charter budgets. Both obey AD-18 (one ledger, attributed records) and both obey AD-5 (they never touch *another module's subtree* — the ledger is at root, in nobody's subtree). Two writers, two independently-invented record shapes, one file.

**Root cause.** AD-5 assigns owners to *subtrees*. Shared runtime services (spend ledger, event bus) have state that belongs to no module's subtree, so AD-5 simply does not reach them.

**Fix:** a new AD making shared runtime services the sole writer of their own state, reached only through their port.

## A2 — Cross-module event subscription is unowned (critical)

**The pair.** OW CAP-11 requires a queue row to leave the list once its loom is "accepted **and** landed," so the workspace module subscribes to a loom event. The looms epic, having published no contract about event names, renames `loom:landed` to `loom:consolidated` during flow-compile work. Both obey AD-14 (one bus, delivery class declared). The workspace's subscription silently stops matching and rows never leave the queue.

**Root cause.** AD-14 fixes the *bus* and the *class* but says nothing about whether a module's event names are binding on subscribers. Combined with the Deferred entry "event catalogue is owned by each module's epic," this actively invites the break.

**Fix:** a new AD making published event names part of a module's port contract, with the same stability guarantee as its tool signatures.

## A3 — Item-kind renderers get their data two different ways (high)

**The pair.** Ultra registers `ultra:run-anchor` as a renderer that reads live run state from a React context its adapter provides. Loom registers `loom:gate-card` as a renderer that receives everything in the item payload. Both obey AD-12 (four slots, registry, shell owns no data fetching) and AD-13 (namespaced ids). The shell now cannot render a transcript containing both kinds outside ultra's provider — and `TranscriptView`, which has neither provider, can render neither.

**Root cause.** AD-12 says the shell owns no data fetching; it does not say how a *registered kind* receives data.

**Fix:** amend AD-12 — a registered renderer is a pure function of `(item payload, shell-provided view state)` and reads nothing from ambient context.

## A4 — Does a lab process consume an admission slot? (high)

**The pair.** LR CAP-11's service epic treats a lab standup as occupancy in the `loom-verify` class and takes a slot. LR CAP-13's verification epic treats admission as governing model calls only and stands labs up freely. Both obey AD-17. Under load the first starves and the second oversubscribes the machine; the effective ceiling is unknowable.

**Root cause.** AD-17 never says what a "slot" admits — `agent()` calls, or any concurrent work.

**Fix:** amend AD-17 to scope it explicitly to `agent()` concurrency, with process/service admission governed by the lease and the per-repo mutex.

## A5 — Reconcile-on-read meets a half-applied land (high)

**The pair.** The landing epic implements AD-18/LR CAP-18's serial queue with a non-idempotent git sequence (branch, fold, push). The restart epic implements AD-15 by reconciling stale `running` to resumable and offering Resume. Both obey their ADs. A restart mid-land leaves the repo half-folded and Resume re-runs the sequence on top of it.

**Root cause.** AD-15 guarantees *reconciliation*, never *rollback*, and nothing requires the mutating operation to be safe to re-enter.

**Fix:** amend AD-15 — any operation mutating the repo or the map must be idempotent and resumable from its own journal.

## A6 — Two homes for session state (medium, contradicts brownfield)

**The pair.** AD-5 names `sessions/<sessionId>/` as owned by the session module. But session state already lives in `~/.telar/chats.json` via `apps/web/lib/store.ts`. A builder reading AD-5 literally migrates chat history into the new tree; another leaves it and uses the tree only for leases. Both obey AD-5.

**Fix:** amend AD-5 — the session tree holds session-scoped *runtime* state (leases, ephemera) and does not replace the existing chat store.

---

## Tail

- **A7 (low)** — AD-6 classes NDJSON as the log-and-projection class, but the AD-14 bus is in-process with no stated persistence. Whether bus events are durable is undecided; two builders will answer differently. Rolled to Deferred.
