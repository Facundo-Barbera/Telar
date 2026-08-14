# Session context integrity — how the UI and the model stay in agreement

Distilled 2026-08-08, from the divergence hunt that produced
`fix/session-context-divergence`. The symptom class it addresses: "the
conversation UI shows something the model behaves as if it never saw, or the
model is told something the UI says was never delivered." Every bug in that
class is a violation of one of the rules below, so the rules are written down
once, here, and the per-file comments point at their own violation histories.

## The two stores, and which one is real

**The model's context is the provider's own resumed session** — the Claude
CLI's live process (`lib/server/session-runtime.ts` holds it open across
turns) or Codex's `thread/resume`. Telar never rebuilds a prompt from its own
transcript.

**Everything Telar persists is a UI projection.** `chats.json` (store.ts),
`live.ndjson` / `feed.ndjson` (session-log.ts), the delta ring — all of it
exists so a reader can watch, reload, and reconnect. None of it is read back
into a prompt. Writing a fact to any of these surfaces delivers it to the
USER, never to the model.

That split gives the whole problem space exactly three failure directions:

1. **UI-only facts** — evidence rendered (or persisted) that never crossed
   into the model's context. The model then contradicts the screen.
2. **Model-only facts** — context delivered to the model that the UI never
   rendered (or rendered as undelivered). The screen contradicts the model.
3. **Double delivery** — the same fact crossing a boundary twice because a
   transport redelivered it and the receiver had no idempotency.

## The two doors into the model

A fact reaches the model through exactly two doors, and anything not walking
through one of them is direction-1 by construction:

- **The live subprocess.** While the session's CLI process is alive, the SDK
  delivers its own facts (a background subagent's `task_notification`, the
  auto-continuation it wakes). This door needs no Telar machinery — but it
  dies with the process, and it cannot reach a turn that is already
  generating (see "mid-generation honesty" below).
- **The system-prompt appendix**, composed fresh on EVERY turn
  (`session-prompts.ts`). This is the durable door, and
  `docs/ultra-wake-delivery.md` is its reference implementation: a
  filesystem-projection **mailbox** as the source of truth (bus events are
  only a fast path — `event-bus.ts` persists nothing, by design), the
  appendix as the delivery, an injected hidden turn as the idle-case trigger,
  and an **ack gated on the composed prompt provably carrying the fact**
  (`appendixCarriesUltraWake`), never on the turn having happened and never
  on which provider ran it.

## The invariants

**INT-1 — A teardown path may not drop accumulated evidence.** Anything
buffered between durable writes (the window sink's parts and task statuses,
a fold's entries) must be flushed by EVERY way its holder can end: settle,
displacement, Stop, and the process dying out from under it. Violation
history: issue #76 (Stop dropped the sink), and `pump()`'s finally (a CLI
crash mid-window dropped it — fixed on this branch,
`session-runtime.ts`).

**INT-2 — Delivery is acked per fact, against evidence, never per channel.**
An ack means "the composed prompt provably carried it", asked of the string
itself. A gate keyed on anything else (a provider name, a turn having run)
silently inverts when wiring changes elsewhere. Violation history: the
`provider !== "codex"` wake-ack gate, written when Codex discarded the
appendix, left in place after the harness port wired the appendix into Codex
— the model was re-told every completion forever while the UI badge said
"undelivered" (fixed on this branch, `app/api/chat/route.ts`; pinned by
`lib/ultra-wake-ack-wire.test.ts`).

**INT-3 — Every replay surface hands its reader a resume point.** A
subscriber that can reconnect will reconnect; a replay with no cursor makes
redelivery certain, and receivers must then distinguish "new fact" from
"same fact, redelivered" — which folds like the compaction reducer
structurally cannot ("a repeated event opens a new compaction" is CORRECT
for genuinely-new events and blind to redelivery). So the transport, not the
receiver, carries the burden: the events route now replays from the
cursor-addressed feed and sends `cursor` to replay subscribers too (fixed on
this branch, `app/api/chat/[sessionId]/events/route.ts`). Where a cursor is
impossible (the degraded live.ndjson fallback), the receiver must rebuild
from EMPTY state, not re-enter old state (`session-view.tsx`'s replay-round
reset). Violation history: the duplicate "Compacted · manual · 731k → 7.9k"
divider pair.

**INT-4 — Mid-generation facts must not be rendered as known.** A completion
arriving while the model is generating is inserted ABOVE the open streaming
block (the never-sever rule, `marker-stream-order.test.ts`), so the
transcript can read "2 agents finished" above text whose author could not
have known it. That is an honest transport doing honest work — the SDK
delivers the notification at the next turn/continuation boundary, not
mid-token — but the ORDER on screen implies knowledge the model did not
have. Accepted for now (the never-sever rule protects streaming
correctness, which is worth more); the roster-empty continuation hold
(PR #85) bounds the window in which the contradiction can appear, because
the model now reliably gets a continuation turn in which to react to the
completion. If this recurs as user confusion, the candidate fix is a visual
one (style the marker as "arrived during generation"), not a reordering.

**INT-5 — One writer per turn, one flush per accumulator.** The compaction
fold is instantiated once per POST and flushed once at stream end; the
session queue dedupes by idempotency key. The residual, accepted: a manual
Compact POST is not idempotency-keyed, so a client retry after a network
blip runs a second REAL compaction — two records with near-identical `at`
and `trigger: "manual"` is the fingerprint of that case, distinguishable
from any fold or replay bug.

## Where to look when the next one appears

- UI shows work the model denies knowing → which door was it supposed to
  walk through? If neither (only `store.ts`/feed writes), it is direction 1
  and needs a mailbox + appendix, not a bigger SSE payload.
- Model repeats something forever / UI says undelivered → find the ack and
  check what its gate is keyed on (INT-2).
- Anything rendered twice with identical copy → find the replay path and ask
  what resume point the reader was given (INT-3), then whether the receiver
  folds redelivery-blind.
- Work vanishes on reload that was visibly streaming → enumerate the
  holder's teardown paths against INT-1; the one without a flush is the bug.
