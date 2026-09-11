# Replies arrive in one block on the iPad

**Reported:** 2026-09-10, looking at the iPad client — "none of the last few
responses you have given have been streamed."

**Session:** `session_b1d34698e99143f4a30f26852b5b5cdf` (orchestrator, Claude
driver, 1M context, ~562k of 1M context used at the time of the last measured
turn).

## The finding, in five lines

The engine streams correctly: deltas leave it with a **19ms median gap**, for
wake turns exactly as for human ones. The phone does not lose them either — the
fold is sound and nothing is dropped. What the phone lacks is the web's
**presentation pacer**. Its transport is a **1-second poll**, so a second of
deltas arrives in one page and the fold hands the view the whole second at once;
the web has spread that burst over the interval that produced it since
`b0f61ba1`, and the phone painted it raw. A reply that finishes inside one poll
is therefore **one paint, by construction** — and wake replies are exactly that
short.

## Measurements

From the live journal (`execution.sqlite`, `events` table), last nine turns of
the session that produced a reply. "1s-poll paints" is a simulation of the
phone's tail against the real delta arrival times — each entry is the number of
characters that would land in a single paint.

| run | origin | started→1st delta | 1st→last delta | deltas | bytes | 1s-poll paints |
|---|---|---|---|---|---|---|
| `4cf32644` | human | 151150 ms | 2879 ms | 133 | 1785 | [659, 687, 439] |
| `28ec4231` | human | 164826 ms | 3479 ms | 136 | 1781 | [77, 710, 726, 268] |
| `528039aa` | human | 83158 ms | 2118 ms | 116 | 1542 | [642, 823, 77] |
| `47d07672` | human | 27195 ms | 1219 ms | 54 | 652 | [500, 152] |
| `b85372aa` | provider / `task_notification` | 9945 ms | **992 ms** | 34 | **437** | **[437]** ← one paint |
| `fbe86d9b` | session (agent-sent) | 39588 ms | 2726 ms | 131 | 2073 | [692, 988, 393] |
| `abfe5e56` | human | 198056 ms | 4234 ms | 213 | 2594 | [563, 629, 588, 705, 109] |
| `3535da47` | provider / `unknown` | 14549 ms | 2159 ms | 112 | 1402 | [701, 631, 70] |
| `94081e4f` | session (agent-sent) | 381619 ms | 3660 ms | 184 | 2033 | [529, 563, 527, 414] |

Inter-delta gaps across all of the above (n=837): **p50 19ms, p90 22ms, p99
41ms, mean 20.4ms, max 202ms**. The engine's own pacing is not the problem.

Two things follow from the table:

1. **No reply gets more than five paints, and the short ones get one.** Even at
   the correct 1-second cadence the reader sees 400–1000 characters — a whole
   paragraph — appear at a stroke. That is what "not streamed" means here.
2. **Wake replies are the short ones.** `b85372aa` (a task notification) ran
   992ms and 437 bytes: literally a single paint. `3535da47` and `47d07672` get
   two or three. Long human-prompted answers get four or five, which still reads
   as chunky but at least moves. The branch name's "replies to wakes arrive in
   one block" is this, and it is a consequence of reply LENGTH, not of anything
   the engine does differently for a wake.

At a 3-second poll — what the phone uses when it believes no turn is active —
six of the nine land in **one** paint. That path is not what happened here (see
below), but it is one snapshot-timing bug away.

## What was ruled out

**1. The clients only stream a turn they consider live; a wake turn is not.**
No. Wake turns go through the full state machine — `turn.accepted` (already
carrying `state: "running"`), `turn.claimed`, `turn.started` — so the fold sets
`.running` and `TurnState.isActive` holds. `SessionSyncEngine.interval` is
therefore 1s, not the 3s idle cadence.

**The fold does not drop deltas either.** The concern was a `content.delta` for
an item whose `item.started` had not been seen (`Journal.swift` ~line 274). In
every measured turn `item.started` precedes its first delta **in event-id
order** — ids 9839→9840, 10102→10103, 9594→9595 — and the fold iterates events
sorted by id, so the row always exists before its text arrives. Nothing to fix.

**2. The engine's delta pacing changed.** No. 19ms median, and identical for
provider-origin turns. `streamedThrough`/snapshot folding on the client is also
correct: it collapses deltas that genuinely arrived within one poll. That part
"is not a bug" — but it is the whole reason a pacer is needed, because the
collapse is what the reader experiences as a block.

**3. A wake turn takes a query path without partial messages.**
No. `includePartialMessages: true` at `apps/engine/src/driver.ts:2165` is
unconditional for session turns (only `warp/spawn.ts:292` sets it false, for
sub-agents). The journal settles it empirically anyway: `3535da47`, a
provider-origin wake, emitted 112 deltas at the same cadence as any human turn.

**4. Time-to-first-token at 500k+ context.** Real but not the complaint. The
`started→1st delta` column is 10s–380s, all of it tool work with visible rows
the whole time. The reader is not staring at nothing; they are watching the
final message land in one lump after it.

## The mechanism

The web is saved twice over and the phone once:

| | web | iOS (before) |
|---|---|---|
| poll | fixed 1s (`session-cockpit.tsx`) | 1s active / 3s idle |
| presentation pacer | `lib/streaming-reveal.ts` + `use-streaming-reveal.ts`, applied in `components/ui/message.tsx` | **none** — `MarkdownText(text: item.text)` |

`streaming-reveal` spreads each arrival over the interval that produced it,
tracking the estimated arrival rate with a reserve and a `maxLagMs` bound. The
phone had no equivalent, so `item.text` went straight to the renderer and each
poll was one paint.

## The fix

Port the pacer rather than poll faster. Polling faster is the wrong lever: it
multiplies request and refold load — the 10-turn window here is 69 items and
143 KiB of item JSON, refolded from scratch every tick — to buy at best a 3–4×
finer chunk, and it can never be smooth, because a poll is inherently bursty.
The web already answered this question; the phone should give the same answer.

- `apps/ios/TelarMobile/Views/StreamingReveal.swift` — a faithful port of
  `streaming-reveal.ts`: same constants, same arithmetic, same invariants.
  `revealText` cuts on Swift grapheme clusters, so it cannot split an emoji or a
  combining mark where the web needs an explicit surrogate guard.
- `apps/ios/TelarMobile/Views/StreamingMarkdown.swift` — the frame clock, at
  **30Hz rather than display rate**, because each frame re-parses the message's
  markdown. Reduced motion shows the text outright.
- `apps/ios/TelarMobile/Views/TranscriptViews.swift` — the assistant-message row
  streams while `item.status == .inProgress`, mirroring the web's
  `running(item)`.

Tests are `apps/ios/TelarMobileTests/StreamingRevealTests.swift`: the web's
vectors one for one, so a drift between the two clients' pacing fails a test,
plus a regression vector for this bug — 437 characters in a single arrival must
spread across frames rather than paint once (it spreads over 70).

## Left open

- **The 3s idle cadence is a latent version of the same bug.** If a snapshot
  ever lands late enough that no turn looks active while one is streaming, six of
  the nine turns above collapse to one paint even with the pacer holding a
  reserve. Worth a look on its own.
- **The pacer's cost on device is unmeasured.** 30Hz markdown re-parse of a
  growing 2KB message inside a scrolling list should be cheap, and the reveal
  only runs while a message is open, but this was not profiled on hardware.
