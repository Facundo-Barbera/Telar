# Restart recovery: why continuing a conversation means pressing "Discard"

**Status:** IMPLEMENTED. This began as an investigation (two rounds, the second
correcting five claims of the first); the diagnosis below is what the shipped
change is built on, and §12 records what actually landed and what deliberately
did not.
**Worktree:** `…/worktrees/investigate-restart-recovery-and-convers-0e63ae-1419724a`
**Branch:** `telar/investigate-restart-recovery-and-convers-0e63ae` · **Base:** `main` @ `89f1b97c`
**Evidence fixtures (untracked, in this worktree):**
`apps/engine/test/restart-recovery-probe.test.ts` (state-level, round 1),
`apps/engine/test/restart-recovery-e2e-probe.test.ts` (real daemon + embedded worker),
`apps/engine/test/restart-recovery-probe2.test.ts` (round 2 corrections).

**Observed** = produced by running those fixtures against real engine code.
**Inference** = reasoning from code read, not from a run.
Provider-internal behaviour is neither observed nor claimed anywhere in this document.

### Corrections to round 1

Five claims in the first draft were wrong or overstated. They are corrected in
place below; recorded here so the diff is legible:

1. ~~"Retry is the only forward door that keeps the session usable."~~ **False.**
   Discard-then-send works today and preserves cursor and transcript (§3, Q1).
   The problem is UX and naming, not capability.
2. ~~"The queued follow-up is stuck behind the ambiguous gate."~~ **False.**
   The gate covers `submitTurn` only, never `claimTurn`. Queued work is
   dispatched while the ambiguity is still unresolved (§4, Q2). This is a more
   serious finding than the one it replaces.
3. ~~"A clean shutdown means we know the turn didn't finish, so it isn't ambiguous."~~
   **Overstated.** It proves interruption, not the absence of side effects (§6).
4. ~~"The provider conversation is reattachable — observed."~~ **Overstated.**
   The fixtures prove *cursor plumbing*, with a fake driver. Provider
   reattachment is code-read only (§7).
5. ~~"A pending approval is auto-resolved cancelled at the boot sweep."~~
   **False** for the case that matters. On an ambiguous turn it stays open
   forever, across every subsequent boot, and holds the session `blocked`
   (§5, Q3). My round-1 reading came from a fixture whose session was not in
   `approval-required` mode, so the request had already been auto-resolved by
   runtime mode at open time — not by the sweep.

---

## 1. The short answer

A clean quit while a turn is running leaves that turn `running` on disk;
nothing settles it. The next boot converts it to `ambiguous`. From there:

- The engine **refuses new messages** (`state.ts:5606`).
- The cockpit offers **"Retry as new run"** (replays the original prompt
  verbatim, `client.ts:751-766`) and **"Discard recovered run"**.
- **Discard is the good path and nobody would guess it.** It clears the
  ambiguity, keeps the partial transcript, keeps the resume cursor, and the
  next message continues the same provider conversation — all observed. It is
  labelled as though it throws work away.

So the honest statement of the bug is: **the natural continuation already
works, but it is hidden behind a destructive-sounding button, while the
prominent button replays your prompt.** A user reasonably reads "Discard
recovered run" as "lose my work" and takes Retry instead.

Two further defects, both found in round 2 and both worse than the above:

- **The gate is on the wrong verb.** It blocks the human's *new* message but
  not the *dispatch* of already-queued work. A follow-up typed before the crash
  is claimed and run against the resumed provider conversation while the
  ambiguity is still unresolved (§4).
- **An approval parked on an ambiguous turn never expires**, holding the
  session `blocked` indefinitely (§5).

---

## 2. Observed: what a clean quit does

`restart-recovery-e2e-probe.test.ts` starts a real daemon with an embedded
worker and a fake driver that reports a provider session id, streams an
assistant message, opens a tool row, then blocks until aborted. It waits for
`running` plus streamed items, calls `daemon.close()` (what the desktop's
`will-quit` SIGTERM triggers, `main.js:1615-1625`), then starts a second daemon
on the same state root.

```
MID-RUN items => [["msg_1","completed"],["tool_1","inProgress"]] resumeCursor => provider-thread-xyz
queue.json state right after a clean quit => [["run_one","running"]]
after restart, turns => [["run_one","ambiguous"]]
after restart, activity => idle resumeCursor => provider-thread-xyz
after restart, items => [["msg_1","completed"],["tool_1","failed"]]
plain follow-up message => REFUSED (conflict): session has an ambiguous turn that must be resolved first
```

**`queue.json` still says `running` after a clean, awaited `daemon.close()`.**
The path: `EngineWorker.stop()` → `controller.abort()` (`worker.ts:275`) → the
driver returns → `execute()`'s catch opens with
`if (controller.signal.aborted …) return;` (`worker.ts:757`). An aborted turn is
deliberately never settled, because abort normally means a human pressed Stop
and the engine already recorded `stopped`. On shutdown nobody recorded
anything, so the turn is abandoned mid-state.

Two comments assert this is handled. Both are stale:

- `daemon.ts:3359-3360` — "The worker stops FIRST: it holds claims, and a claim
  outliving the server it reports to becomes an ambiguous turn on the next
  start." It becomes one anyway.
- `main.js:1592-1596` — "The engine also holds the store's lock and reconciles
  in-flight turns on the way out." `main.ts:43-46` calls only `daemon.close()`,
  and nothing in `close()` (`daemon.ts:3355-3378`) settles a turn.

The partial transcript survives and the tool row is correctly re-marked
`failed`; the resume cursor survives. The material for a real continuation is
all on disk.

---

## 3. Observed (Q1): discard-then-continue already works

From `restart-recovery-probe2.test.ts` — restart, `discardAmbiguousTurn`, then
an ordinary message, then a worker claim:

```
Q1 submit => queued
Q1 claim => {"runId":"run_new","input":"What did you find in the parser?","resumeCursor":"claude-thread-abc"}
Q1 transcript survives => [["msg_1","completed"],["tool_1","failed"]]
Q1 turns => [["run_lost","discarded"],["run_new","claimed"]]
```

The new turn carries the lost run's resume cursor, the original prompt is not
replayed, and the transcript is intact. `discardAmbiguousTurn` keeps the turn
in the journal as `discarded` (`state.ts:6196-6216`) — it discards the
*pending decision*, not the work.

**So the fix is smaller than round 1 implied.** The engine can already do what
the user wants. What is missing is a "Continue" affordance that performs
discard-then-prepare-composer as one gesture, and honest naming for the
destructive-sounding button that currently does the useful thing.

---

## 4. Observed (Q2): the gate is on submission, not dispatch

`claimTurn` (`state.ts:5720-5734`) checks only for `claimed`/`running` turns.
There is no ambiguous check, and `claimNextTurn`'s candidate scan
(`state.ts:5836-5843`) has none either. Fixture:

```
Q2 pre-restart states  => [["run_lost","running"],["run_followup","steering"]]
Q2 recover()           => {"requeued":["run_followup"],"ambiguous":["run_lost"]}
Q2 post-restart states => [["run_lost","ambiguous"],["run_followup","queued"]]
Q2 claim while ambiguous => {"runId":"run_followup","input":"also update the docs","resumeCursor":"claude-thread-abc"}
Q2 states after claim  => [["run_lost","ambiguous"],["run_followup","claimed"]]
Q2 activity            => queued
Q2 new submit while ambiguous => REFUSED: session has an ambiguous turn that must be resolved first
```

The follow-up is claimed and handed the resume cursor **while `run_lost` is
still ambiguous and undecided.** So the current design:

- lets *un-reviewed* pre-crash work resume the provider conversation
  automatically, before any human decision;
- refuses the *one* message a human is present to authorise.

That is precisely backwards relative to its stated purpose. The safety story in
`state.ts:6191-6195` ("an ambiguous turn may already have reached a provider,
so it is never replayed") holds for the ambiguous turn itself, but the session
is not otherwise quiesced.

**This changes S1.** Round 1 proposed "remove the `submitTurn` refusal so the
backlog unblocks". The backlog was never blocked. The real choice is a design
question for the user, stated in §8 as **Q-backlog**.

---

## 5. Observed (Q3): approvals on an ambiguous turn never expire

Session in `approval-required` mode, an approval opened on the lost turn:

```
Q3 pre-restart request => [["req_open","open"]]
Q3 boot1 turn => ambiguous   boot1 request => [["req_open","open"]]   boot1 activity => blocked
Q3 boot2 turn => ambiguous   boot2 request => [["req_open","open"]]   boot2 activity => blocked
Q3 after discard request => [["req_open","resolved"]]
Q3 after discard activity => idle
```

**First-vs-second sweep, as asked:** the first boot does *not* cancel it. The
sweep's loop skips live turns outright — `if (turn.state === "queued" ||
"claimed" || "running") continue;` (`state.ts:6787`) — so a `running` turn is
passed over *before* the running→ambiguous conversion further down
(`state.ts:6819`). On every subsequent boot the turn is already `ambiguous`,
and line 6795 explicitly exempts ambiguous turns. So the request is cancelled
by **neither** sweep, on **any** boot. Only `discardAmbiguousTurn`
(`state.ts:6212`) retires it.

Consequences today: the session reads `blocked` (`state.ts:5356`) — sidebar
"Waiting on you", composer in answer mode — over a question no worker is
waiting on, forever. The web client compensates client-side
(`failed-turn-recovery.ts:38-41`, `actionableRequests`, whose comment says
exactly this), but the engine's own state is wrong, and any client without that
workaround inherits the bug.

The intent behind keeping it open is defensible — the request is evidence of
what the lost run was doing, and the human's decision is still pending. But
"keep the evidence" and "hold the session blocked and the request actionable"
are separable, and only the first is wanted. **Recommendation: retire the
request as `cancelled` at the sweep (so `blocked` clears and no client can
answer a phantom), while keeping the row visible in the transcript as part of
what the ambiguous turn was doing.**

---

## 6. Observed (Q4) + inference: what a clean shutdown does and does not prove

**Observed — engine-level fencing is real.** A zombie worker holding the
pre-restart claim token is refused on every write path:

```
Q4 zombie worker with the pre-restart claim token => {
  "ingestObservations": "REFUSED: turn is not running under this worker claim",
  "completeTurn":       "REFUSED: turn is not running under this worker claim",
  "failTurn":           "REFUSED: turn is not running under this worker claim"
}
Q4 turn state after => ambiguous
```

`requireRunningClaimFromQueue` (`state.ts:7040-7047`) gates on the turn being
`running` under that exact token, so a recovered turn cannot be written to by
the old claim. Stale-lease fencing for *engine writes* is sound today, and any
change that lets a continuation dispatch concurrently must keep it.

**What it does not cover, and the round-1 draft blurred:**

1. **Side effects are not fenced.** A clean shutdown proves the turn was
   interrupted. It proves nothing about what the run had *already done* — a
   `git push`, an `rm`, an outbound API call are all committed to the world
   before any abort arrives. So even a shutdown-interrupted turn carries an
   unknown-outcome property, and marking it non-blocking must not be confused
   with marking it harmless. **Record the interruption; retain the uncertainty.**
2. **"The process is gone" is a bookkeeping assumption, not a verified fact.**
   `recover()` closes every live background task with "the process that owned
   this task is gone" (`state.ts:6854`), and `recoverInactiveWorker` does the
   same (`state.ts:6889`). On a clean quit that is well-founded:
   `worker.stop()` → `driver.dispose()` (`worker.ts:283-292`) → the runtime's
   `close()`, documented as "stdin closes, then SIGTERM escalating to SIGKILL"
   (`claude-runtime.ts:96`). On **SIGKILL of the engine, nothing disposes at
   all** — no code runs. Whatever the CLI had launched detached
   (`is_backgrounded`, `driver.ts:1004-1010, 1492`) is a grandchild of a
   process that died without reaping it. Inference, not measured here: those
   can outlive the engine, while the engine's journal has already recorded them
   `stopped`.
3. **Therefore the crash path must keep more caution than the quit path**, and
   neither should permit *concurrent* continuation dispatch until the stale
   claim is provably fenced (it is, per Q4) **and** the disposal order is known
   to have run (it is not, on a crash).

---

## 7. Provider reattachment: cursor plumbing only

**Observed:** `resumeCursor` survives the restart and survives a discard; the
next claim carries it (Q1, Q2 above). That is the engine's plumbing, proven
with a **fake** driver.

**Code-read, not observed:** both drivers reattach by id — Claude via the SDK's
`resume` option (`driver.ts:2073`), Codex via `thread/resume`
(`codex-driver.ts:714-719`). Both report the id the moment they learn it,
specifically so a non-completing turn does not lose it (`driver.ts:2286-2290`,
`codex-driver.ts:725-728`).

**Unverified, and not claimed anywhere in this document:** whether a resumed
Claude or Codex conversation can see the *partial* interrupted turn — the
assistant text and tool calls in flight when its process was killed. No
fixture here exercises a real provider; the brief forbids live provider calls.
Any implementation must degrade gracefully if the answer is "no". Telar's own
journal holds the partial transcript regardless, which is what
`continuationDraft` (`failed-turn-recovery.ts:49-54`) already leans on.

**No cursor at all** is a real case: a turn that died before the first frame
has none (round-1 probe: `resumeCursor => undefined` for a `claimed`-at-death
turn). A continuation then cold-starts the provider with an empty context. The
UI must say so rather than implying continuity.

---

## 8. Recommended behaviour

Matching the stated preference: clean quit → interrupted, ordinary composer
continuation; crash → Continue abandons the lost execution without resending
the prompt, preserving journal, cursor and the record of uncertainty.

| At death | Turn state | New submissions | Dispatch of queued backlog | Primary affordance | Resends original prompt? |
|---|---|---|---|---|---|
| `queued`, never claimed | `queued` | allowed | normal | none | n/a |
| `claimed`, provider never spawned | `queued` | allowed | normal | none | yes, and safely — see below |
| `running`, **clean quit** | **`interrupted`** (terminal, non-blocking, retains unknown-side-effect record) | **allowed** | normal | ordinary composer; "Continue" prepares text | **no** |
| `running`, crash / SIGKILL / lease expiry | `ambiguous` | **allowed** | **held until decided** (change) | "Continue" · "Re-run this prompt" · "Discard" | only on explicit Re-run |
| `steering` undelivered | `queued` | allowed | held with the rest until decided | none | n/a |
| Approval open on interrupted/ambiguous turn | request **cancelled** at sweep, row kept in transcript | allowed | — | none | no |
| No resume cursor | as above | allowed | — | same, plus explicit "the agent will not remember the earlier turn" | no |

The `claimed`-at-death auto-requeue stays exactly as it is:
`markTurnRunning` runs *before* the driver is constructed, and `worker.ts:416-419`
says the ordering is load-bearing, so `claimed` provably means no provider was
spawned. Re-dispatch there is safe and should not change.

**Three verbs, distinctly named:**

- **Continue** — a *new* turn in the *same* provider conversation, in the
  user's own words. Abandons the lost execution; never replays. Primary.
- **Re-run this prompt** — deliberately re-executes the lost input as a fresh
  run, with copy naming the risk ("may repeat work or tool calls that already
  happened"). Secondary. This is today's "Retry as new run".
- **Discard** — records the decision and stops there.

### Q-backlog — needs the user's decision

Given §4, a session recovering from a crash may hold queued work written for a
conversation state that no longer exists. Three options:

- **(a) Hold dispatch until the ambiguity is decided.** Safest, matches what
  users assume the gate already does, and is the change §4 implies. Costs: a
  detached/headless session stalls until a human returns.
- **(b) Dispatch as today.** No stall; un-reviewed pre-crash work resumes the
  provider conversation before any decision. This is the status quo and I do
  not recommend it now that it is visible.
- **(c) Hold, and surface the backlog in the recovery card** ("2 messages were
  waiting — send them, or drop them"). Most honest, most UI work.

My recommendation is **(a)** for a first cut, **(c)** as the destination. It is
a behaviour change either way and it should be a deliberate one.

---

## 9. Proposed scope

**S1 — Ambiguity gates dispatch, not submission (engine).** Remove the
`submitTurn` refusal at `state.ts:5606`; add the ambiguous check to
`claimTurn`/`claimNextTurn` (`state.ts:5720-5734`, `5836-5843`) per Q-backlog
option (a). Net effect: the human can talk, the machine waits for the human.
This is the inverse of the round-1 S1 and the correction matters.

**S2 — Honest shutdown state (worker + engine).** Have `EngineWorker.stop()`
settle its active claims before returning (`worker.ts:271-293`) and have
`execute()`'s abort branch distinguish shutdown-abort from human-Stop-abort
(`worker.ts:757`). Recommend `failed` with a distinguished
`failure.code: "interrupted"` for a first cut — cheapest, and it reuses the
existing continuation affordance wholesale. The uncertainty about side effects
must survive into the copy (§6), so "interrupted" must not read as "nothing
happened".

**S3 — Approval expiry (engine).** Retire requests on ambiguous turns at the
sweep so `blocked` clears (§5), keeping the row in the transcript. The
client-side workaround at `failed-turn-recovery.ts:38-41` then becomes belt and
braces rather than the only defence.

**S4 — UI (web).** Rewrite `RecoveryActions` (`session-cockpit.tsx:328-346`) to
the three verbs above, with Continue primary and implemented as
discard-then-prepare-composer — which, per §3, is a thin wrapper over engine
behaviour that already works. Let `recoverableFailedTurn`
(`failed-turn-recovery.ts:22-29`) stop bailing when an ambiguous turn exists.
Extend `continuationDraft` to say when there is no resume cursor.

**S5 — iOS.** Nothing in `apps/ios` calls the discard route
(`TurnModels.swift:7` and `Journal.swift:307` know the state; no caller). A
session that goes ambiguous is unusable from the phone. S1 alone fixes the
wedge, since submission stops being refused; the affordance is still wanted.

**S6 — Comment repair.** `daemon.ts:3359-3360`, `main.js:1592-1596` (§2).

Out of scope: reconstructing how far the lost run got by reading the provider's
own transcript. Provider-specific, and unnecessary — the human deciding is
cheaper and more honest.

---

## 10. Acceptance tests

Engine:

1. A `running` turn at `daemon.close()` settles as interrupted, not
   `ambiguous`, asserted on `queue.json` *before* the second boot. Inverts §2.
2. With an ambiguous turn present, `submitTurn` succeeds.
3. With an ambiguous turn present, `claimNextTurn` returns nothing for that
   session — inverts the observed Q2 line, and is the S1 behaviour change.
4. After the ambiguity is resolved, the held backlog dispatches in accepted
   order.
5. A new turn after discard carries the lost turn's `resumeCursor` (pins
   today's Q1 behaviour, which must not regress).
6. A `claimed`-at-death turn still auto-requeues with its original input.
7. A `steering` turn still requeues as its own turn.
8. An approval on an ambiguous turn is cancelled at the sweep and the session
   is not `blocked` (S3) — inverts Q3.
9. A stale pre-restart claim token is refused on `ingestObservations`,
   `completeTurn` and `failTurn` (pins Q4; must survive S1).
10. A crash-shaped death (no `worker.stop()`) still yields `ambiguous`.
11. `recover()` is idempotent (`state.test.ts:187`; keep).

Web:

12. `recoverableFailedTurn` offers a continuation for an interrupted turn even
    with an ambiguous turn elsewhere in the session.
13. `continuationDraft` never contains the original prompt; appends after an
    existing draft (both already asserted; keep).
14. "Continue" issues discard + composer preparation and **no** submit.
15. "Re-run this prompt" still discards then submits under a fresh run id
    (`client.test.ts:53`; keep, retitle).
16. With no `resumeCursor`, the card says the agent will not remember the
    earlier turn.

Regression guard: `state.test.ts:278` (`submitTurn` throws `/ambiguous/`)
must be **inverted** by S1, and a *new* assertion must take its place on
`claimNextTurn`. Flag in review so the relaxation is deliberate rather than
accidental.

---

## 11. Outstanding questions

**Q-backlog (§8).** Hold, dispatch, or hold-and-surface. Needs the user's
call; it is a visible behaviour change either way. Recommendation: hold.

**Q-interrupted-shape.** First-class turn state, or `failed` +
`failure.code: "interrupted"`? The variant is much cheaper and reuses the
existing affordance; a distinct state reads more honestly in the transcript and
sidebar chip. Recommendation: variant first.

**Q-provider-memory (not blocking S1/S3/S4, blocks copy accuracy).** Does a
resumed Claude or Codex conversation see the partial interrupted turn? One live
experiment answers it (start a turn, `kill -9` the CLI, resume, ask what it
remembers) — deliberately not run, per the brief. If the answer is "no", the
continuation must carry salient context from Telar's journal, which is a larger
prompt-construction job.

**Q-orphans (§6).** On SIGKILL, do detached CLI grandchildren actually survive
while the journal records them `stopped`? Inference only. Measurable offline
with a process-tree check; worth knowing before any claim that recovery leaves
no live work behind, but it does not block the UX fix.

---

## 12. What shipped

Implemented on `telar/investigate-restart-recovery-and-convers-0e63ae`, on top of
`main` with PR #178 (session inbox) and #179 (TeX) already merged in.

### Engine

- **The gate moved from `submitTurn` to `claimTurn`** (`state.ts`). A person may
  always write; nothing in the session EXECUTES while an ambiguous turn is
  undecided. `claimNextTurn`'s candidate scan skips held sessions too, so one
  held session cannot stall every other session's queue for a poll interval.
- **`interrupted`, a new `TurnFailureCode`** (`entities.ts`). A clean quit now
  settles its running turns as `failed` + `interrupted` instead of abandoning
  them at `running`. `failed` rather than a new turn STATE on purpose: every
  client already treats it as terminal and non-blocking, and the cockpit already
  offers a continuation on one, so iOS and web both inherit the fix without
  learning a new state.
- **`WorkerTurnFailureCode`**, one definition of the worker-sendable subset.
  Adding `interrupted` found three hand-maintained copies of that list (the fail
  route, the store's `TURN_FAILURE_CODES`, the client's `failTurn` signature) —
  two accepted the new code while the third rejected it at compile time. They
  now all derive from the contract.
- **Zombie approvals are retired** on both recovery paths, and — the half that
  was missing — at the moment a `running` turn BECOMES ambiguous. The pre-existing
  sweep skips live turns, so closing them only there cured this on no boot at
  all. `recoverInactiveWorker` gets the same treatment.

### Worker

- `stop()` sets `shuttingDown`, aborts, then AWAITS the in-flight runs (bounded,
  2 s) before returning — `daemon.close()` shuts the HTTP server immediately
  after, so an unawaited settle would race the socket it needs.
- The interruption is recorded from BOTH ways an aborted run ends: the driver
  throwing, and — the common case, and the one a first pass missed entirely —
  the driver returning cleanly, which lands on the completion branch rather than
  in the catch.
- Failure to settle degrades to the old behaviour (turn stays `running`, next
  boot calls it `ambiguous`), which is the honest answer when we could not say.

### Cockpit

- The recovery card offers **Continue** (primary) · **Re-run this prompt** ·
  **Discard**, and says how many messages are held behind the decision.
  `continueAfterAmbiguousTurn` is a discard and nothing else — its signature does
  not even accept `submitTurn`, so "Continue resends the prompt" is not a
  regression that can be written.
- `recoverableFailedTurn` no longer hides behind an ambiguous turn elsewhere in
  the session.
- `continuationDraft` takes `resumable`: with no provider cursor it says the
  agent will not remember the conversation instead of pointing at work only the
  human can see.

### Tests

Engine: the shutdown→restart round trip against a real daemon and a fake
provider (`embedded-worker.test.ts`); backlog held then released in order with
its cursor; discard-then-fresh-message continuity; and the three inverted
assertions in `state.test.ts`, each rewritten to say why it flipped.
Web: Continue submits nothing; Continue refuses a non-ambiguous turn; the
no-cursor draft; an interrupted turn reaching the ordinary continuation.

### Still true, still unverified

The fixtures use a FAKE provider. What they prove is Telar's own bookkeeping —
turn states, transcript, resume cursor, what the next boot accepts. **Whether a
real Claude or Codex conversation can still see the partial turn after its
process was killed is untested here** (Q-provider-memory, §11), and the
continuation is written so that a "no" costs correctness rather than data: the
journal holds the transcript either way.

### Deliberately not done

- **iOS (S5).** S1 un-wedges it — submission is no longer refused, so a phone can
  talk its way out of a recovered session — but the three verbs are still
  web-only. Worth a follow-up.
- **Q-orphans (§11).** Untouched; no claim in this change depends on it.
