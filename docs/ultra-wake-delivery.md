# The Ultra completion wake's delivery seam

`apps/web/lib/ultra-wake.ts` is Story 4.1 / FR-UW-1's delivery seam: the
PURE, dependency-free module shared by the client (`session-view.tsx`), the
server (`app/api/chat/route.ts`) and the system-prompt composer
(`session-prompts.ts`), so all three agree on the contract and it is
unit-testable without importing any of them. Modelled on
`apps/web/lib/escalation-kickoff.ts`, which is the same shape for the same
reason — read that file before changing this one. This document holds the
full reasoning; the source file holds only the point-of-use notes.

## The flow

1. A detached Ultra run reaches a terminal state. `packages/core`'s
   `pendingUltraWakes(sessionId)` reports it, durably, whether or not the
   bus event survived (see `packages/core/src/ultra/wake.ts`'s header — the
   projection is the guarantee, the publish is the fast path).
2. **Idle session:** `use-ultra-wake.ts` polls `GET /api/ultra/wakes`, and
   `session-view` pushes `ULTRA_WAKE_SENTINEL` into the EXISTING injection
   queue, which drains through the EXISTING idle gate. The turn fires with
   `hidden: true`, so no user bubble renders.
3. `route.ts` recognizes the sentinel and swaps it for `ULTRA_WAKE_PROMPT`,
   so the model is driven by a server-authored instruction. The client never
   authors the facts — it authors only the trigger.
4. The outcome reaches the model as the system-prompt appendix
   (`formatUltraWakeAppendix`, composed in `session-prompts.ts`) — on EVERY
   turn, not only a wake turn. That is what makes AC1 and AC2 one mechanism
   with two triggers rather than two features: the mailbox is the source,
   the appendix is the delivery, and the injected turn is only the trigger
   for the idle case. A mid-conversation run simply lands on the next turn
   the user starts.
5. The route acks the wakes it carried, so the same outcome is never stated
   twice.

**Template, not tracing paper — the one inverted condition.** Escalation's
`isEscalationKickoff` is true only when `!sessionId`, because "a kickoff is
always turn 1". A wake is structurally the REVERSE: it exists only for a run
whose manifest already names a session, and it fires on an idle,
already-resumed session. A recognizer that mirrored the template
line-for-line would NEVER FIRE. See `isUltraWakeTrigger` and its named test.

## `freshUltraWakes` — why the latch lives here and not inline

This is the latch that decides whether an unprompted turn fires, and until
the story-4.1 review it lived inline in `session-view.tsx` where nothing
could execute it — which is exactly how SF-1 (a second run finishing inside
the first wake turn never got its turn) shipped and was then found by
reading rather than by running. §6.2 classes the RENDER as unprovable
without a DOM; the DECISION is not, so it is out here where a test can
drive it.

The contract, in three sentences: a run is announced at most once per
terminal — the caller enqueues ONE trigger however many runs are fresh
(T10), because the appendix carries a list. A run that is still pending
stays announced, so a turn that has not yet been acked cannot re-fire. A run
that DROPS OUT of pending is forgotten, which is what re-arms a run resumed
to a new terminal under the same id (see `UltraWakeRecord.deliveredTerminalAt`).

## `shouldEnqueueUltraWake` — the second half of T10

Out here for the same reason `freshUltraWakes` is: the fix round's own
adversarial pass refuted an earlier version of the SF-1 latch that had
`freshUltraWakes` alone deciding, and the defect was invisible until
something executed the rule over time. What it refuted: the announced-SET
stops one run being announced twice, but it does NOT stop a SECOND run
enqueueing a SECOND trigger while the first is still undispatched — which
the boolean latch it replaced could never do. With the drain blocked (the
§1b reconnect tail), run A queues a trigger and run B queues another; the
first turn's appendix carries BOTH and acks both; the second then fires a
hidden turn against an empty appendix. `session-view`'s SF-2 drop-guard
cannot catch that: it reads a poll snapshot that lags the server-side ack by
up to `POLL_MS`. So the queue is asked directly, at enqueue time, where the
answer is exact.

One trigger, however many runs — the appendix's formatter takes a list,
which is the whole reason T10 is satisfiable at all. A run marked announced
but not separately triggered is correct, not lost: the trigger already
queued composes its appendix from the mailbox at DISPATCH time, not at
enqueue time.

## The per-run outcome budget

This is the ONE lossy hop in an otherwise lossless pipeline, and it used to
be a flat 1200 characters. The engine keeps full fidelity end to end —
`emit_result` has no cap, the journal has none, `manifest.result` is written
verbatim and `ultra_status` returns it whole — so a research-report-sized
result was cut mid-sentence HERE and nowhere else.

**Why a shared budget and not simply a bigger constant:** this block rides
EVERY turn's system prompt until it is acked, and the run LIST is unbounded
in `n`, so a flat 10x per-run raise is a 10x worse worst case. Dividing a
total budget across the runs actually present keeps the worst case where it
was; the floor is what makes "never renders less than it does today" true
by construction rather than by hoping `n` stays small.

```
n=1 → 12000, n=2 → 12000, n=3 → 8000, n=10 → 2400, n≥20 → 1200.
```

The run-LIST bound itself (n runs × the floor) stays exactly as unbounded as
it is today — `deferred-work.md` L162/L187 already records it as an
accepted bound, and this change neither closes nor worsens it.

## Why the truncation notice's placement rules are load-bearing

When `clip` cuts, it says BOTH things the model needs: that text is
missing, and how to get it. The recovery instruction is honest FOREVER, not
just this turn: the ack (`route.ts` → `ackUltraWakes`) stamps delivery so
the outcome never re-appears in this block, but it touches nothing
`ultra_status` reads — `ultra_status` is a pure disk read of
`manifest.json`, which carries `result` verbatim for a `done` run and
`error` for a `failed` one, for good.

Two placement rules, both load-bearing rather than cosmetic. The notice
rides a CONTINUATION line (never one starting with the bullet) and carries
no `(run <id>)` marker — because `appendixCarriesUltraWake` decides what the
route is allowed to ACK by scanning for lines that start with the bullet AND
contain the marker. A notice satisfying both would let one run's truncation
answer for another run's delivery.

## Why `appendixCarriesUltraWake` is line-scoped rather than a substring search

The appendix embeds a run's arbitrary `result` text, so a plain substring
search lets ONE RUN'S OUTPUT ANSWER FOR ANOTHER — a script that happens to
print `(run u-xyz)` would make this return true for `u-xyz`, which on the
ack path means acking a run the model was never shown. Requiring the marker
on a line that begins with the formatter's own bullet removes the
accidental case entirely; the residue is a deliberately forged bullet line,
which needs an author who already controls a run to also know a sibling's
id, and whose worst outcome is one wake stated zero times instead of once.
Recorded in `deferred-work.md` rather than closed, because closing it
properly means giving the composer a data channel back to the route, and
`SessionProfile` has no field for one.

The ack needs this check because AC7's exactly-once is a claim about
DELIVERY, not about a turn having happened: a wake marked delivered on a
turn that did not carry it has been delivered ZERO times, which is the one
outcome `packages/core/src/ultra/wake.ts`'s header says is impossible.
Asking the composed prompt whether the run is actually in it is the only
check that cannot be fooled by a composer whose read failed
(`safeLiveContext` degrades to `""`) or by a provider that discards the
appendix (`runCodexTurn` takes no `systemPrompt`). Found by the story-4.1
code review as SF-3.
