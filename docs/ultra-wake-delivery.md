# The Ultra completion wake's delivery seam

`apps/web/lib/ultra-wake.ts` is Story 4.1 / FR-UW-1's delivery seam: the
PURE, dependency-free module shared by the ticket author
(`lib/server/session-engine.ts`), the server (`app/api/chat/route.ts`) and the
system-prompt composer (`session-prompts.ts`), so all three agree on the
contract and it is
unit-testable without importing any of them. Modelled on
`apps/web/lib/escalation-kickoff.ts`, which is the same shape for the same
reason — read that file before changing this one. This document holds the
full reasoning; the source file holds only the point-of-use notes.

## The flow

1. A detached Ultra run reaches a terminal state. `packages/core`'s
   `pendingUltraWakes(sessionId)` reports it, durably, whether or not the
   bus event survived (see `packages/core/src/ultra/wake.ts`'s header — the
   projection is the guarantee, the publish is the fast path).
2. **Idle session:** the engine's `scanSessionMachinery` enqueues ONE durable
   ticket per pending wake — key `wake:<runId>:<terminalAt>`, wire message
   `ULTRA_WAKE_SENTINEL`, `kind: "wake"`, `hidden: true` — into the session's
   own queue, which drains through the EXISTING one-turn-at-a-time dispatcher.
   No user bubble renders, and no queue surface draws the ticket as a line.
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

## The latch: what it had to guarantee, and where it lives now

The trigger was client-authored until the machinery moved server-side, and
this section is kept because the RULES survived the move even though the two
functions that held them (`freshUltraWakes`, `shouldEnqueueUltraWake`) did
not. Both were deleted with their only caller; each one's job has a named
successor.

**A run is announced at most once per terminal.** Was an announced-runs `Set`
in a component ref — which is exactly how it failed: a remount emptied it, so
a wake could re-announce, and a closed tab meant it never announced at all.
It is now the idempotency key `wake:<runId>:<terminalAt>`, which lives in
`queue.json` for the life of the session, so however often the engine scans,
a terminal event mints one ticket. Keying on the TERMINAL and not the run
preserves the re-arm rule: a run resumed to a new terminal under the same id
is a new outcome and earns a new ticket (`UltraWakeRecord.deliveredTerminalAt`).

**T10: one turn, however many runs.** The story-4.1 review's adversarial pass
refuted the announced-set alone. It stops one run being announced twice, but
not a SECOND run enqueueing a SECOND trigger while the first is undispatched:
with the drain blocked (the §1b reconnect tail), run A queues a trigger and
run B queues another; the first turn's appendix carries BOTH and acks both;
the second then fires a hidden turn against an empty appendix. The client's
answer was an enqueue-time queue check, because its SF-2 drop-guard read a
poll snapshot that lagged the ack by up to `POLL_MS`. The server has no such
staleness, so the check moved to where it is exact and later: the drain
re-validates a CLAIMED wake ticket and commits it without running a turn when
the outcome it names is settled. Surplus tickets are therefore free — the first
ticket's turn acks every wake its appendix carried, and the ones behind it cost
a state transition each.

**That re-validation takes POSITIVE EVIDENCE, and the difference is a lost
outcome.** It first asked `pendingUltraWakes(sessionId).length === 0` — but that
projection swallows every read failure it meets (`getUltraManifest` and
`readUltraWakeRecord` both answer null on an unreadable or half-written file),
so "the mailbox reads empty" and "the outcome was delivered" are the same
answer to it. One unreadable moment at claim time committed the only ticket
that terminal would ever have, and the retained key deduped every rescan
afterwards: the wake was lost silently and forever. The drain therefore asks
for a fact instead — the run's `UltraWakeRecord` stamped `deliveredTerminalAt`
equal to this ticket's terminal, or a manifest that has moved PAST that
terminal (a stopped run resumed before its wake drained, whose new terminal
mints its own ticket). Anything it cannot establish runs the turn: delivered
twice is the direction this module tolerates, lost is not.

One turn, however many runs, still holds for the reason it always did: the
appendix's formatter takes a list, and a ticket composes its appendix from the
mailbox at DISPATCH time, not at enqueue time.

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
