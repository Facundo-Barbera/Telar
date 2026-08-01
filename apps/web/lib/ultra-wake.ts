// Story 4.1 / FR-UW-1 — the completion wake's DELIVERY seam.
//
// This module is the PURE, dependency-free half shared by the client
// (session-view.tsx), the server (app/api/chat/route.ts) and the system-prompt
// composer (session-prompts.ts), so all three agree on the contract AND it is
// unit-testable without importing any of them. Modelled on
// `apps/web/lib/escalation-kickoff.ts`, which is the same shape for the same
// reason — read that file before changing this one.
//
// THE FLOW:
//   1. A detached Ultra run reaches a terminal state. `packages/core`'s
//      `pendingUltraWakes(sessionId)` reports it, durably, whether or not the
//      bus event survived (see packages/core/src/ultra/wake.ts's header — the
//      projection is the guarantee, the publish is the fast path).
//   2. IDLE SESSION: `use-ultra-wake.ts` polls `GET /api/ultra/wakes`, and
//      session-view pushes ULTRA_WAKE_SENTINEL into the EXISTING injection
//      queue, which drains through the EXISTING idle gate. The turn fires with
//      `hidden: true`, so no user bubble renders.
//   3. route.ts recognizes the sentinel and swaps it for ULTRA_WAKE_PROMPT, so
//      the model is driven by a server-authored instruction. THE CLIENT NEVER
//      AUTHORS THE FACTS — it authors only the trigger.
//   4. The OUTCOME reaches the model as the system-prompt appendix
//      (`formatUltraWakeAppendix` below, composed in session-prompts.ts) — on
//      EVERY turn, not only a wake turn. That is what makes AC1 and AC2 one
//      mechanism with two triggers rather than two features: the mailbox is the
//      source, the appendix is the delivery, and the injected turn is only the
//      trigger for the idle case. A mid-conversation run simply lands on the
//      next turn the user starts.
//   5. The route acks the wakes it carried, so the same outcome is never stated
//      twice.
//
// TEMPLATE, NOT TRACING PAPER — the one inverted condition. Escalation's
// `isEscalationKickoff` is true only when `!sessionId`, because "a kickoff is
// always turn 1". A wake is structurally the REVERSE: it exists only for a run
// whose manifest already names a session, and it fires on an idle, already-
// resumed session. A recognizer that mirrored the template line-for-line would
// NEVER FIRE. See `isUltraWakeTrigger` and its named test.

// The sentinel carried as the wire `message` of the injected turn. Opaque on
// purpose: the client suppresses the user bubble, route.ts always substitutes it
// before the model sees it, and `hideUserMessage` keeps it out of the persisted
// transcript — so a human could never type this by accident and reach the wake
// branch.
export const ULTRA_WAKE_SENTINEL = "__telar_ultra_wake__";

// The canonical instruction route.ts feeds the model IN PLACE OF the sentinel.
// Server-authored, never client-injectable, and deliberately thin: it says only
// "speak about what the appendix already told you". The FACTS live in the
// appendix, which is composed server-side from the durable record — so a
// tampered client can cause a turn to happen and can never cause a turn to state
// an outcome that did not occur.
//
// THE FINAL CLAUSE IS TWO CLAUSES, NOT ONE, and the order matters: the default
// is still "do not poll" (that is what stops a wake turn degenerating into a
// poll), and the exception is named in the SAME string so a model reading only
// the first half cannot conclude there is none. The exception exists because the
// appendix now clips a large outcome and SAYS SO — an instruction that forbade
// ultra_status unconditionally would make that truncation permanent. Keep this
// wording in sync with formatUltraWakeAppendix's header line below; they are two
// strings in one file for exactly that reason.
export const ULTRA_WAKE_PROMPT =
  "A detached Ultra run you launched for this session has just finished. The COMPLETED ULTRA RUNS block in your context above carries each run's outcome — its state, and its result or its error. Tell the user, unprompted, in one or two sentences per run: which run finished, whether it succeeded, and the single most useful thing about the outcome. If a run failed or was stopped, say so plainly and say what it reported. You already have these outcomes, so do not call ultra_status merely to re-read one. The ONE exception is an outcome the block marks as truncated: if you need the omitted text to say something useful, call ultra_status(runId) for that run's full result. Do not restate these instructions.";

// SERVER: is THIS POST the injected wake trigger? True only for the exact
// sentinel on a session that already exists.
//
// THE `sessionId` GATE IS INVERTED RELATIVE TO THE ESCALATION TEMPLATE, and the
// inversion is the point: a wake belongs to a run whose `UltraManifest.sessionId`
// is set, and the trigger fires on an idle, already-resumed session — so a
// truthy `sessionId` is a precondition, not a disqualifier. Copying
// `isEscalationKickoff`'s `!sessionId` here yields a recognizer that is false on
// every legitimate wake and true only on a turn-1 sentinel no client ever sends.
// `apps/web/lib/ultra-wake.test.ts` asserts the empty-`sessionId` case by name.
export function isUltraWakeTrigger(
  sessionId: string | null | undefined,
  message: unknown,
): boolean {
  return !!sessionId && message === ULTRA_WAKE_SENTINEL;
}

// SERVER: the effective prompt the model runs for this turn — the canonical wake
// instruction for a recognized trigger, otherwise the caller's message verbatim.
// Byte-identical to the input for every other turn, so no existing path changes.
export function resolveUltraWakeMessage(
  sessionId: string | null | undefined,
  message: string,
): string {
  return isUltraWakeTrigger(sessionId, message) ? ULTRA_WAKE_PROMPT : message;
}

// CLIENT: which of this poll's pending runs have not been announced yet, and
// the announced-set to carry into the next poll.
//
// PURE AND LIVING HERE ON PURPOSE. This is the latch that decides whether an
// unprompted turn fires, and until the story-4.1 review it lived inline in
// session-view.tsx where nothing could execute it — which is exactly how SF-1
// (a second run finishing inside the first wake turn never got its turn) shipped
// and was then found by reading rather than by running. §6.2 classes the RENDER
// as unprovable without a DOM; the DECISION is not, so it is out here where a
// test can drive it.
//
// The contract, in three sentences. A run is announced at most once per terminal
// — the caller enqueues ONE trigger however many runs are fresh (T10), because
// the appendix carries a list. A run that is still pending stays announced, so a
// turn that has not yet been acked cannot re-fire. A run that DROPS OUT of
// pending is forgotten, which is what re-arms a run resumed to a new terminal
// under the same id (see UltraWakeRecord.deliveredTerminalAt).
export function freshUltraWakes(
  announced: ReadonlySet<string>,
  pendingRunIds: readonly string[],
): { fresh: string[]; announced: Set<string> } {
  // One pass, rebuilding rather than deleting: an id absent from
  // `pendingRunIds` is simply never carried over, which IS the pruning. Building
  // a new set also keeps this free of aliasing on the caller's, so the caller
  // can hold it in a ref without the prune being visible before the assignment.
  const next = new Set<string>();
  const fresh: string[] = [];
  for (const id of pendingRunIds) {
    if (next.has(id)) continue; // a duplicate within one poll is still one run
    next.add(id);
    if (!announced.has(id)) fresh.push(id);
  }
  return { fresh, announced: next };
}

// CLIENT: given this poll's fresh runs and what is already waiting in the
// injection queue, may this poll enqueue a wake trigger?
//
// THE SECOND HALF OF T10, and it is out here for the same reason the first half
// is: the fix round's own adversarial pass refuted an earlier version of the
// SF-1 latch that had `freshUltraWakes` alone deciding, and the defect was
// invisible until something executed the rule over time. What it refuted: the
// announced-SET stops one run being announced twice, but it does NOT stop a
// SECOND run enqueueing a SECOND trigger while the first is still undispatched —
// which the boolean latch it replaced could never do. With the drain blocked
// (the §1b reconnect tail), A queues a trigger and B queues another; the first
// turn's appendix carries BOTH and acks both; the second then fires a hidden
// turn against an empty appendix. session-view's SF-2 drop-guard cannot catch
// that: it reads a poll snapshot that lags the server-side ack by up to
// POLL_MS. So the queue is asked directly, at enqueue time, where the answer is
// exact.
//
// One trigger, however many runs — the appendix's formatter takes a list, which
// is the whole reason T10 is satisfiable at all. A run marked announced but not
// separately triggered is correct, not lost: the trigger already queued composes
// its appendix from the mailbox at DISPATCH time, not at enqueue time.
export function shouldEnqueueUltraWake(
  fresh: readonly string[],
  queued: readonly { text: string }[],
): boolean {
  if (fresh.length === 0) return false;
  return !queued.some((i) => i.text === ULTRA_WAKE_SENTINEL);
}

// What the formatter needs. Declared STRUCTURALLY rather than imported from
// `@telar/core`, so this module keeps zero module edges and stays trivially safe
// to reach from a "use client" file (AD-3). `PendingUltraWake` satisfies it by
// shape, which is checked where the two meet in session-prompts.ts.
export type UltraWakeSummary = {
  runId: string;
  name: string;
  state: "done" | "failed" | "stopped";
  spendUsd: number;
  result?: unknown;
  error?: string;
  // Did the agent explicitly register interest in THIS run (core's
  // `watchUltraRun`, surfaced by `pendingUltraWakes` as `PendingUltraWake.watched`)?
  // Optional and structural, like the rest of this type: a caller that knows
  // nothing about watching renders exactly what it rendered before.
  watched?: boolean;
};

// ── the per-run outcome budget ──────────────────────────────────────────────
//
// THE ONE LOSSY HOP IN AN OTHERWISE LOSSLESS PIPELINE, and it used to be a flat
// 1200 characters. The engine keeps full fidelity end to end — emit_result has
// no cap, the journal has none, manifest.result is written verbatim and
// ultra_status returns it whole — so a research-report-sized result was cut
// mid-sentence HERE and nowhere else.
//
// WHY A SHARED BUDGET AND NOT SIMPLY A BIGGER CONSTANT: this block rides EVERY
// turn's system prompt until it is acked, and the run LIST is unbounded in n, so
// a flat 10x per-run raise is a 10x worse worst case. Dividing a total budget
// across the runs actually present keeps the worst case where it was; the FLOOR
// is what makes "never renders less than it does today" true by construction
// rather than by hoping n stays small.
//
//   n=1 → 12000, n=2 → 12000, n=3 → 8000, n=10 → 2400, n≥20 → 1200.
//
// The run-LIST bound itself (n runs × the floor) stays exactly as unbounded as it
// is today — deferred-work.md L162/L187 already records it as an accepted bound,
// and this change neither closes nor worsens it.
export const WAKE_OUTCOME_FLOOR = 1200; // today's flat value, now the lower bound
export const WAKE_OUTCOME_CEILING = 12_000; // ~3k tokens — a real synthesis report survives
export const WAKE_OUTCOME_BUDGET = 24_000; // total across the whole block

export function wakeOutcomeAllowance(n: number): number {
  if (n <= 0) return WAKE_OUTCOME_CEILING;
  const share = Math.floor(WAKE_OUTCOME_BUDGET / n);
  return Math.min(WAKE_OUTCOME_CEILING, Math.max(WAKE_OUTCOME_FLOOR, share));
}

// When it cuts, it says BOTH things the model needs: that text is missing, and
// how to get it. The recovery instruction is HONEST FOREVER, not just this turn:
// the ack (route.ts → ackUltraWakes) stamps delivery so the outcome never
// re-appears in this block, but it touches nothing ultra_status reads —
// ultra_status is a pure disk read of manifest.json, which carries `result`
// verbatim for a `done` run and `error` for a `failed` one, for good.
//
// TWO PLACEMENT RULES, both load-bearing rather than cosmetic. The notice rides a
// CONTINUATION line (never one starting with the BULLET) and carries no
// `(run <id>)` marker — because `appendixCarriesUltraWake` decides what the route
// is allowed to ACK by scanning for lines that start with the bullet AND contain
// the marker. A notice satisfying both would let one run's truncation answer for
// another run's delivery.
function clip(s: string, allowance: number, runId: string): string {
  if (s.length <= allowance) return s;
  const omitted = s.length - allowance;
  return (
    `${s.slice(0, allowance)}\n  …(truncated: ${omitted} of ${s.length} characters omitted — ` +
    `call ultra_status("${runId}") for this run's full result)`
  );
}

// A run's terminal payload, rendered honestly per state:
//   done    → its `result` (JSON when structured, verbatim when a string)
//   failed  → its `error`
//   stopped → NEITHER, and it says so. A stop has no resolved value and no
//             failure; inventing one for it would be the model's cue to
//             summarize something that does not exist.
//
// `stopped` never clips, so it never emits a recovery instruction it could not
// honour: a stopped run has neither `result` nor `error` for ultra_status to
// hand back.
function outcomeLine(w: UltraWakeSummary, allowance: number): string {
  if (w.state === "stopped") {
    return "outcome: stopped before finishing — no result and no error were recorded.";
  }
  if (w.state === "failed") {
    return `error: ${clip(w.error?.trim() || "(the run failed and recorded no error text)", allowance, w.runId)}`;
  }
  if (w.result === undefined) return "result: (the run completed and returned nothing)";
  const text = typeof w.result === "string" ? w.result : safeJson(w.result);
  return `result: ${clip(text.trim() || "(empty)", allowance, w.runId)}`;
}

// A script's return value is arbitrary and may be circular or hold a BigInt.
// Neither is a reason to fail a turn, so the failure degrades to a shape note.
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return "(the run returned a value that could not be serialized)";
  }
}

// THE ONE SPELLING OF "this run's outcome is in this block", used by the
// renderer below AND by the route's ack, so the two cannot drift.
//
// The ack needs it because AC7's exactly-once is a claim about DELIVERY, not
// about a turn having happened: a wake marked delivered on a turn that did not
// carry it has been delivered ZERO times, which is the one outcome
// packages/core/src/ultra/wake.ts's header says is impossible. Asking the
// composed prompt whether the run is actually in it is the only check that
// cannot be fooled by a composer whose read failed (`safeLiveContext` degrades
// to "") or by a provider that discards the appendix (`runCodexTurn` takes no
// systemPrompt). Found by the story-4.1 code review as SF-3.
const BULLET = "• ";
const runMarker = (runId: string) => `(run ${runId})`;

// The visible half of `ultra_watch` (core's `watchUltraRun`). A tool that only
// printed a sentence and changed nothing observable would be the prose form of
// the placebo story 4.2's AC11 forbids — this marker is what makes the
// registration real in the one place the model actually reads. It sits AFTER
// `runMarker` on the bullet line, so the ack predicate's two anchors are unmoved.
const WATCHED_MARKER = " — you asked to be told about this one";

// SERVER: did the composed system-prompt appendix ACTUALLY carry this run's
// outcome? Line-scoped rather than a whole-string `includes`, and the scoping is
// load-bearing: the appendix embeds a run's arbitrary `result` text, so a plain
// substring search lets ONE RUN'S OUTPUT ANSWER FOR ANOTHER — a script that
// happens to print "(run u-xyz)" would make this return true for `u-xyz`, which
// on the ack path means acking a run the model was never shown. Requiring the
// marker on a line that begins with the formatter's own bullet removes the
// accidental case entirely; the residue is a deliberately forged bullet line,
// which needs an author who already controls a run to also know a sibling's id,
// and whose worst outcome is one wake stated zero times instead of once.
// Recorded in deferred-work.md rather than closed, because closing it properly
// means giving the composer a data channel back to the route and
// `SessionProfile` has no field for one.
//
// Line-oriented is also why the formatter and this share `runMarker`: the render
// and the check must agree on one spelling, and a test pins the anchoring.
export function appendixCarriesUltraWake(appendix: string, runId: string): boolean {
  if (!runId) return false;
  const marker = runMarker(runId);
  return appendix.split("\n").some((line) => line.startsWith(BULLET) && line.includes(marker));
}

// The per-turn appendix block — the DELIVERY half of AC1 and AC2, and the only
// place the outcome text is authored.
//
// "" FOR AN EMPTY LIST, never a stray header. This composes on every chat POST
// for every session, so the overwhelmingly common case is no wakes at all and it
// must add exactly nothing — a lone "COMPLETED ULTRA RUNS" heading with no runs
// under it is an instruction to talk about nothing.
export function formatUltraWakeAppendix(wakes: readonly UltraWakeSummary[]): string {
  if (wakes.length === 0) return "";
  // ONE allowance for the whole block, computed from the list length — see
  // wakeOutcomeAllowance. Computed once here rather than per run so every run in
  // one block is rendered on the same terms.
  const allowance = wakeOutcomeAllowance(wakes.length);
  const runs = wakes.map((w) =>
    [
      // THE WATCHED MARKER GOES AFTER THE RUN MARKER, on the same bullet line, so
      // the two positions `appendixCarriesUltraWake` keys on are unmoved.
      `${BULLET}${w.name} ${runMarker(w.runId)} — ${w.state}, $${w.spendUsd.toFixed(4)}${w.watched ? WATCHED_MARKER : ""}`,
      `  ${outcomeLine(w, allowance)}`,
    ].join("\n"),
  );
  return [
    "\n\n--- COMPLETED ULTRA RUNS (this turn only) ---",
    // THE SAME TWO-CLAUSE RULE ULTRA_WAKE_PROMPT CARRIES, and the two strings
    // live in one file precisely so they cannot disagree: the instruction the
    // model reads in its context and the instruction it reads as its turn prompt
    // are the same instruction.
    "Detached Ultra runs launched from this session have reached a terminal state since you last spoke. You ALREADY HAVE their outcomes below, so do not call ultra_status merely to re-read one. The ONE exception is an outcome marked as truncated: if you need the omitted text, call ultra_status(runId) for that run's full result. Mention them to the user; you will not be shown them again.",
    ...runs,
  ].join("\n");
}
