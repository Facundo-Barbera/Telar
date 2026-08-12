// Story 4.1 / FR-UW-1 — the completion wake's DELIVERY seam. PURE and
// dependency-free, shared by the client (session-view.tsx), the server
// (app/api/chat/route.ts) and the system-prompt composer (session-prompts.ts)
// so all three agree on the contract and it is unit-testable without
// importing any of them. Modelled on apps/web/lib/escalation-kickoff.ts —
// read that file before changing this one.
//
// Full flow (mailbox → idle-turn injection → prompt swap → appendix delivery
// → ack) and the template's one inverted condition vs. escalation-kickoff:
// docs/ultra-wake-delivery.md

// The sentinel carried as the wire `message` of the injected turn. Opaque on
// purpose: the client suppresses the user bubble, route.ts always substitutes it
// before the model sees it, and `hideUserMessage` keeps it out of the persisted
// transcript — so a human could never type this by accident and reach the wake
// branch.
export const ULTRA_WAKE_SENTINEL = "__telar_ultra_wake__";

// The canonical instruction route.ts feeds the model IN PLACE OF the sentinel.
// Server-authored, never client-injectable, and deliberately thin: it says only
// "speak about what the appendix already told you". The FACTS live in the
// appendix, composed server-side from the durable record — a tampered client
// can cause a turn to happen and can never cause it to state an outcome that
// did not occur.
//
// THE FINAL CLAUSE IS TWO CLAUSES, NOT ONE: the default stays "do not poll",
// and the truncation exception is named in the SAME string so a model reading
// only the first half cannot conclude there is none. Keep this wording in
// sync with formatUltraWakeAppendix's header line below — two strings in one
// file for exactly that reason.
export const ULTRA_WAKE_PROMPT =
  "A detached Ultra run you launched for this session has just finished. The COMPLETED ULTRA RUNS block in your context above carries each run's outcome — its state, and its result or its error. Tell the user, unprompted, in one or two sentences per run: which run finished, whether it succeeded, and the single most useful thing about the outcome. If a run failed or was stopped, say so plainly and say what it reported. You already have these outcomes, so do not call ultra_status merely to re-read one. The ONE exception is an outcome the block marks as truncated: if you need the omitted text to say something useful, call ultra_status(runId) for that run's full result. Do not restate these instructions.";

// SERVER: is THIS POST the injected wake trigger? True only for the exact
// sentinel on a session that already exists.
//
// THE `sessionId` GATE IS INVERTED RELATIVE TO THE ESCALATION TEMPLATE — a
// wake fires on an idle, ALREADY-resumed session, so a truthy `sessionId` is
// a precondition here, not a disqualifier as it is in isEscalationKickoff.
// Copying that function's `!sessionId` here would make this false on every
// legitimate wake. `ultra-wake.test.ts` asserts the empty-`sessionId` case by
// name.
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
// PURE AND LIVING HERE ON PURPOSE, not inline in session-view.tsx — this is
// the latch that decides whether an unprompted turn fires, and it must be
// something a test can drive (see SF-1 in docs/ultra-wake-delivery.md for
// what shipped while it wasn't).
//
// The contract, in three sentences. A run is announced at most once per
// terminal — the caller enqueues ONE trigger however many runs are fresh
// (T10), because the appendix carries a list. A run that is still pending
// stays announced, so a turn that has not yet been acked cannot re-fire. A
// run that DROPS OUT of pending is forgotten, which is what re-arms a run
// resumed to a new terminal under the same id (see
// UltraWakeRecord.deliveredTerminalAt).
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
// THE SECOND HALF OF T10 — checked at the QUEUE directly, at enqueue time,
// because the announced-set alone does not stop a second run enqueueing a
// second trigger while the first is undispatched, and session-view's SF-2
// drop-guard reads a poll snapshot that can lag the server-side ack. Full
// refutation history: docs/ultra-wake-delivery.md.
//
// One trigger, however many runs — the appendix's formatter takes a list. A
// run marked announced but not separately triggered is correct, not lost:
// the trigger already queued composes its appendix from the mailbox at
// DISPATCH time, not at enqueue time.
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
// THE ONE LOSSY HOP IN AN OTHERWISE LOSSLESS PIPELINE — the engine keeps full
// fidelity end to end (emit_result, the journal, manifest.result, ultra_status
// all carry it whole), so a large result is cut mid-sentence HERE and nowhere
// else. Budget shared across the run list rather than a flat per-run cap, so
// growing `n` cannot make the worst case worse; measurements and the accepted
// run-list bound: docs/ultra-wake-delivery.md.
//
//   n=1 → 12000, n=2 → 12000, n=3 → 8000, n=10 → 2400, n≥20 → 1200.
export const WAKE_OUTCOME_FLOOR = 1200; // today's flat value, now the lower bound
export const WAKE_OUTCOME_CEILING = 12_000; // ~3k tokens — a real synthesis report survives
export const WAKE_OUTCOME_BUDGET = 24_000; // total across the whole block

export function wakeOutcomeAllowance(n: number): number {
  if (n <= 0) return WAKE_OUTCOME_CEILING;
  const share = Math.floor(WAKE_OUTCOME_BUDGET / n);
  return Math.min(WAKE_OUTCOME_CEILING, Math.max(WAKE_OUTCOME_FLOOR, share));
}

// When it cuts, it says BOTH things the model needs: that text is missing,
// and how to get it (ultra_status stays a full read forever — see
// docs/ultra-wake-delivery.md for why the ack never affects that).
//
// TWO PLACEMENT RULES, both load-bearing: the notice rides a CONTINUATION
// line (never one starting with the BULLET) and carries no `(run <id>)`
// marker, because appendixCarriesUltraWake below scans for lines that start
// with the bullet AND contain the marker — a notice satisfying both would let
// one run's truncation answer for another run's delivery.
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
// outcome? LINE-SCOPED, NOT A WHOLE-STRING `includes` — a run's arbitrary
// `result` text is embedded in the appendix, so a plain substring search
// lets one run's output answer for another (a script printing "(run u-xyz)"
// would falsely pass for u-xyz). Requiring the marker on a line starting
// with the formatter's own bullet closes the accidental case; the residual
// deliberately-forged case is recorded in deferred-work.md rather than
// closed. Full reasoning: docs/ultra-wake-delivery.md
//
// Line-oriented is also why the formatter and this share `runMarker`: the
// render and the check must agree on one spelling, and a test pins the
// anchoring.
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
