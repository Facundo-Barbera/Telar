# Journal compaction, reviewed for correctness — 2026-09-19

`compactJournal` deletes rows from every session's history, on a timer, with no
human watching. It shipped in #646/#661 and had not been reviewed. This is that
review, against `10f6beab`.

**Verdict: no reachable data-loss path found.** The guard that authorises each
delete is more conservative than it needs to be, and the two cases where it is
theoretically content-blind are not reachable from any driver in this tree. The
review found nothing that should hold a release.

### Read this part even if you read nothing else

**Compaction almost never fires.** Only a single-stream `assistant_message` or
`reasoning` item is ever swept. Every command execution, tool call, file read,
file change, browser action and plan is **structurally exempt** — their text
lives at `detail.command`, `detail.call`, `detail.read`, `detail.change` or
`detail.plan`, never at `detail.text`, so the guard's
`json_extract($.item.detail.text)` returns NULL, `COALESCE` makes it `''`, and
the comparison fails shut. Nothing is at risk from this; it fails in the safe
direction. But two things follow.

**One — #646's measured headline numbers do not describe what the shipped guard
reaches.** 57% of a million rows and 68% of a gigabyte were real measurements,
but nothing in the code or its comments records that whole categories of item
can never qualify. A reader comparing those figures to what a sweep actually
removes will find them irreconcilable and have no way to learn why.

**Two — the obvious "fix" is the dangerous edit.** Someone who notices the
shortfall and loosens the guard to reach those items would be removing the exact
check that makes the interrupted-turn and append-after-settle cases safe (§3).
The guard is not too strict by accident. **Do not loosen it without replacing
the safety it provides.**

Also worth having: one of the three entry points is **silent by construction**
in a way the button is not (§2), and two behaviours are **correct today only for
reasons nobody wrote down** (§6) — the guard compares lengths rather than
content and holds only because no current driver revises text on completion, and
`export-execution.ts` arms a compaction timer that is harmless only because
`exportLegacy` is synchronous.

---

## 0. #661 did not cause the execution-store flake. Neither did #646.

Stated first because two people reached the opposite conclusion from the same
evidence on the day, and the next reader will too unless this page refuses it.

`execution-store.test.ts:112` was failing intermittently, on the same afternoon
#661 merged, in a test named *"export retains post-migration history"*, against
a change whose subject line is *"drop the journal rows a settled turn
supersedes"*. Every word of that lines up. It is still wrong.

The failure was `SQLITE_BUSY` thrown from the `ExecutionStore` **constructor**,
on `PRAGMA journal_mode=WAL`, because `busy_timeout` was set two statements
later and a pragma only governs what follows it. The export child died before
`exportLegacy` was called and therefore before compaction could run at all —
the failing path does not reach `compactJournal`.

That pragma has been in the wrong order since **`da1c110c` (2026-09-09)**, ten
days before the journal work. #646 and #661 widened the window by adding a
second opener and more work per run; they did not create it. Fixed in #684
(`7b77a276`); measured 7 failures in 30 runs before, 0 in 60 after.

**Do not re-attribute that flake to compaction.**

---

## 1. What compaction treats as superseded

`compactSession` works one session at a time, inside a transaction, over the
half-open range `(watermark, high]`, where `high` is the id of the newest
terminal turn event — `turn.completed`, `turn.failed`, `turn.stopped`,
`turn.ambiguous`, `turn.discarded`. `turn.steered`, `turn.requeued` and
`turn.released` are deliberately excluded, which is correct: they move a turn
without ending it and the items under them are still open.

It deletes two things.

**`content.delta` rows**, but only for an item that also has an
`item.completed` **inside the same window**, and only when

```
LENGTH(completed.detail.text) >= SUM(LENGTH(delta.text))
```

**`item.started` rows**, for any item with an `item.completed` in the window —
with **no length guard at all**. That asymmetry is fine: `item.completed`
carries the whole `Item` object including `startedAt`, so the started row holds
nothing its completion does not.

Bounding the `item.completed` subquery to the window as well as the deltas is
load-bearing, and the code knows it. It is what makes the append-after-settle
cases safe (§3).

## 2. Three entry points, three different failure behaviours

They are not variations on one thing, and a failure in each is noticed by
different people — or by nobody.

| | path | attended? | a throw is… |
| --- | --- | --- | --- |
| **Button** | Settings → Storage → `state.ts` → `reclaim()` | yes | **propagates to the caller** |
| **Constructor timer** | `:575`, once, ~5 s after every open | no | swallowed |
| **Prune timer** | `:555`, every `RECEIPT_PRUNE_EVERY_MS`, for the process's life | no | swallowed |

`reclaim()` calls `compactJournal()` **directly** and has no `try`, so a failure
reaches the button and the person who pressed it. That is the only path with a
witness.

**A correction worth recording, because it was asserted twice during this
review and is false.** The `try` at `:554` does cover `pruneReceipts()` only,
and `this.sweepJournal()` on the next line does sit outside it — but that has no
consequence, because `sweepJournal` wraps *its own entire body* in
`try { … } catch {}` (`:581-589`). It cannot throw to either timer. The two
unattended paths therefore behave **identically**, not differently: both are
silent. The real asymmetry is button-versus-timers, not constructor-versus-prune.

The consequence stands even though the reasoning changed: **a compaction bug on
either timer path produces no error, no log line, and no user-visible signal.**
`onJournalCompacted` fires only on success, and it is inside the same `try`, so
a throwing subscriber is swallowed too.

## 3. Where "a settled turn's items are final" could be false — and why it holds

Each of these was checked against the code and then against fixtures.

**An item appended to after its turn settled** (resume, fork, adoption). Late
deltas land above the watermark; the item's `item.completed` is below it. The
`settled` subquery is bounded to the same window, so it does not match, the JOIN
finds nothing, and the deltas are kept. Conservative, and correct.

**A turn interrupted mid-stream.** `closeOpenItems` writes
`item.completed` with `status: "failed"` and `{...item}` — and since
`content.delta` deliberately never touches the item projection, that text is
whatever it was, usually empty. So `settled.chars` is 0, the guard fails, and
the deltas that are the only record of the partial reply survive. This is the
case the guard exists for and it works.

**Adopted Claude Code conversations** (#616, `claude-adopt.ts`). Adoption writes
completed items; it does not stream deltas into a settled turn. Nothing for
compaction to mis-pair.

**Multi-stream items.** `ContentStream` is
`assistant_text | reasoning_text | command_output | tool_output | unknown`, and
the protocol explicitly allows one item to carry several — *"a command has its
own output, and the assistant may narrate around it."* The delete sums **all**
streams and compares that total against the single `detail.text`, so a
mixed-stream item's sum overshoots and the guard refuses. Stronger still: only
three `ItemDetail` variants have a top-level `text` at all — `user_message`,
`assistant_message`, `reasoning`. Every command and tool variant nests its
content under `command`, `call`, `change`, `read` or `plan`, so
`json_extract($.item.detail.text)` is NULL, `COALESCE` makes it `''`, and any
such item with deltas fails the guard outright. Both effects point the same,
safe way. See §4.

**Two processes at once.** Single-writer is enforced by `acquireDaemonLock`,
which the export script takes and the daemon holds, so the two cannot sweep the
same store concurrently. The sweep itself runs inside a transaction, so a
concurrent append is either visible to it or lands above `high` and waits for
the next sweep; the watermark can therefore never skip an unexamined row. Event
ids come from a **per-process** cache (`MAX(id)` once, then memory), so two
writers on one session would collide on `PRIMARY KEY(session_id, id)` — that
hazard is real, but it is the daemon lock's job, it predates compaction, and
compaction neither widens nor depends on it.

## 4. The finding that is not a bug: compaction mostly does not fire

Because the guard sums every stream against one `detail.text`, any item
carrying more than one stream fails it. Measured on fixtures:

| fixture | swept |
| --- | --- |
| text deltas, completed with the full text | deltas dropped ✓ |
| **thinking + text deltas, completed holds only the text** | **nothing dropped** |
| completed longer than the deltas | deltas dropped ✓ |
| interrupted, completed text empty | nothing dropped |
| thinking only, completed empty | nothing dropped |

Only a single-stream `assistant_message` or `reasoning` item is ever compacted.
Every command, tool call, file read, browser action and plan is skipped — not by
intent, but because their text is not at `detail.text`.

That is the safe direction, so it is not a defect. But #646's headline numbers —
57% of a million rows, 68% of a gigabyte — were measured against a store, and
nothing in the code or its comments records that whole categories of item are
structurally exempt. Anyone who later "fixes" the guard to reach them would be
removing the very check that makes §3 safe. **That is the dangerous edit this
page exists to warn against.**

## 5. What is unrecoverable, and who reads it

Deleted rows are gone; there is no backup of the journal and `reclaim()`
VACUUMs, returning the pages to the filesystem.

One reader rebuilds from `content.delta`: `openItemPrefix`
(`state.ts:11502`), which reconstructs an **open** item's streamed prefix after
the engine bounces, so a reader arriving mid-reply still sees the text. It only
ever runs for items with no `item.completed` — exactly the rows compaction is
forbidden to touch. The cockpit's `journal.ts` folds deltas while streaming and
prefers `item.completed` once it lands.

`exportLegacy` writes whatever survives into `events.ndjson`, so an export taken
after a sweep contains the compacted journal. That is the intended behaviour and
the export test asserts the *completed* history, not the deltas.

One incidental note: `export-execution.ts` arms a 5-second compaction timer of
its own when it opens the store, so a script whose job is to **read** history can
in principle mutate it. It does not, because `exportLegacy` and `close()` are
both synchronous and the timer is cleared before the event loop turns. That is
correct today for a reason nobody wrote down, and it would break silently the
day `exportLegacy` gains an `await`.

## 6. What this review does not establish

- It is a **code-and-fixture** review. No real store was opened; the live store
  at `~/Library/Application Support/Telar/engine/` was never touched.
- It did not audit `reclaim()`'s VACUUM, `pruneReceipts`, or `sweepLegacyBackup`
  beyond where they touch the sweep.
- The equal-length-different-content hole in the guard is **real but not
  reachable**: no driver in this tree emits an `item.completed` whose text
  differs from its own deltas while being at least as long. That is a property
  of the current drivers, not a guarantee the guard enforces. A future driver
  that revises text on completion would silently break the invariant, and the
  guard would not catch it.
