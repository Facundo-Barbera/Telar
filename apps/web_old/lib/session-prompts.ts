// The per-kind system-prompt appendices — the three static prompts, the
// per-turn Ultra note, and the two live-context readers — hoisted out of
// app/api/chat/route.ts by story 2.2.
//
// WHY THIS MODULE EXISTS, and it is a measurement rather than a preference.
// PLANNER_SYSTEM_PROMPT, STEERER_SYSTEM_PROMPT and ESCALATION_SYSTEM_PROMPT
// were module-private consts inside a Next.js route module whose ONLY export is
// POST. A SessionProfileSpec builder in lib/session-profiles.ts cannot reach a
// route module's private const, and copying ~90 lines of moat-adjacent prompt
// text would have created a SECOND source of truth for it — the failure mode
// this repo has paid for more than once. story 2.1 recorded the blocker in
// deferred-work.md and named 2.2 as the owner; this file is that decision
// executed. The prompt bodies below are MOVED, not retyped: a single changed
// character changes model behaviour and no test in this tree would catch it.
//
// WHAT IT REPLACES. The route used to branch three ways on session kind to
// build `systemPrompt.append` (isEscalationSession ? … : isSteererSession ? … :
// isPlannerSession ? … : ultraAnnotationNote ? … : …). AD-9's promise is that a
// new surface adds a profile and not an `if`; that chain was the largest single
// `if` standing between the promise and the handler. Each arm now lives with
// the builder for its kind, which is what lets tracks D, E and F add a session
// kind without editing the route.
//
// STORY 4.1 WIDENED WHAT FOLLOWS FROM TWO KINDS TO FOUR-MINUS-ONE. The paragraph
// below was written when only steerer and escalation performed live reads.
// PROJECT, PLANNER and STEERER now each perform one more — the completed-Ultra-run
// block (buildUltraWakeContext), which reads the ultra subtree — because an Ultra
// run can be launched from any non-escalation session and its outcome has to be
// able to come back to whichever session launched it. Escalation is the one kind
// that does NOT get it, and that is enforced by its signature carrying no
// `sessionId` at all. The reasoning below is unchanged and so is the fail-safe:
// EACH live read sits inside its OWN safeLiveContext, so a failure drops that
// block and nothing else.
//
// THE PROPERTY THIS FILE BENDS, stated plainly because the alternative is
// discovering it in review. Composing a steerer or escalation appendix performs
// FILESYSTEM READS (getLoom, readBundleFile, readContract,
// deriveDeliverableSignal). The core fold in packages/core/src/session-profile.ts
// stays pure — it takes an already-read context and calls a surface-owned
// function — but a BUILDER is no longer pure. That is honest and it is correct:
// the kind -> live-context mapping IS the registry, and every design that keeps
// the read in the route puts the branch back in the route. The rejected
// alternative was passing a pre-computed `loomContext: string` on the
// resolution context — computing it requires knowing the kind, so the route
// would have to branch to compute it. That is AC1 defeated by indirection.
//
// FAIL-SAFE IS NOT OPTIONAL HERE. These reads used to happen INSIDE
// `new ReadableStream`, where a throw becomes an SSE `error` event on an open
// stream. They now happen PRE-STREAM, where a throw is a bare 500 with no SSE
// frame at all. safeLiveContext below wraps the live read and NOTHING ELSE, so
// a failure degrades to the static prompt — never to a 500, and never to an
// empty appendix. An empty appendix would silently drop the moat language that
// IS the steerer and escalation kinds: a 500 converted into a silent
// degradation, which is strictly worse than the 500.
//
// AD-3 / AD-5: this module imports @telar/core at RUNTIME (getLoom,
// readBundleFile, readContract, deriveDeliverableSignal, STEERING_FILE), so it
// is server-only and must never become reachable from a "use client" file —
// INV-4 enforces that transitively through value edges. It composes NO path off
// the state root; everything path-shaped arrives already resolved, through
// core's exported ports or on the caller's context. INV-3a's site inventory is
// unchanged by this file, and that is a requirement rather than an observation.
import {
  deriveDeliverableSignal,
  getLoom,
  pendingUltraWakes,
  readBundleFile,
  readContract,
  STEERING_FILE,
} from "@telar/core";
import { formatEscalationContext } from "@/lib/loom-mcp";
import { ULTRA_AUTHORING_REFERENCE } from "@/lib/ultra-authoring";
import { formatUltraWakeAppendix } from "@/lib/ultra-wake";

// --- The three static prompts (moved verbatim from route.ts) -----------------

// Appended (never replacing) the "claude_code" preset system prompt for a
// Loom Session (docs/loom-model.md §5's "planner" role) — see
// `isPlannerSession` below. Guidance only: it does not grant any tool the
// session doesn't already have (LOOM_AUTO_TOOLS/LOOM_START_TOOL + the
// PreToolUse guardrail are the actual moat) and a non-planner session's
// systemPrompt is completely unaffected.
export const PLANNER_SYSTEM_PROMPT = `You are helping the user plan a LOOM in Telar — an autonomous unit of work Telar will build and then independently verify. Your ONLY job in this session is planning, not coding. Workflow:
1. Understand what the user wants to build (ask brief, focused questions).
2. Draft a Spec Bundle with your loom tools: use draft_bundle_file to write the objective and any useful context (spec files, examples, constraints), and propose_contract to define a FALSIFIABLE Verification Contract — concrete, checkable assertions (golden-diff / value-equality / schema-match / contains / live-critic), never vague prose. propose_contract will reject an unfalsifiable contract.
3. Show the user the plan (read_bundle) and refine until they're happy.
4. When the spec is solid AND the user confirms, call start_loom. This ASKS THE USER TO APPROVE — you cannot start a loom yourself; that human approval is required by design. After it starts, tell the user the loom is building and verifying autonomously and that they can watch it in the god-view.
Do NOT write the feature's code yourself — the loom's builder does that. Keep your messages concise and guide the user through the plan.
When you need to clarify something, ask it as a plain chat message and wait for the user's reply — never use a structured question/interactive tool; the chat has no UI to answer those.

OBJECTIVE — the most important thing you write. objective.md is the single source of truth for what the loom builds; write it (via draft_bundle_file, path "objective.md") BEFORE calling start_loom. It must:
- Describe the CONCRETE CHANGE to make in the project — the actual feature/fix/refactor and its acceptance shape — distilled from the WHOLE conversation.
- NEVER be the meta-request to create/draft/start the loom, a restatement like "let's work on #109", or a raw fragment of the user's chat message. "Create the loom" is not a task.
If the user's ask is vague or is only a pointer (an issue number, "the thing we discussed"), ask focused questions and read the referenced material until you can state the real objective — do not draft a placeholder objective.`;

// Appended (never replacing) the "claude_code" preset for a STEERER Loop
// Session (docs/loom-model.md §5) — the loom Chat tab. Like PLANNER above this
// is guidance only: it grants ZERO tools (the moat lives in this text plus the
// unchanged LOOM_AUTO_TOOLS/LOOM_START_TOOL gating + PreToolUse guardrail). The
// hard rule below forbids any accept/promote/mark-done attempt — acceptance is
// a human click made OUTSIDE this chat, and there is no accept_loom tool.
export const STEERER_SYSTEM_PROMPT = `You are embedded in the cockpit of a RUNNING loom as its steering session. Your
job is to answer "what's going on?" and to redirect the loom on the owner's behalf.

You can OBSERVE and STEER this loom with the mcp__loom__ tools, all of which
default to THIS loom:
  • get_loom / read_bundle — inspect state, verdict, objective, contract.
  • steer_loom {directive} — fold a course correction in and re-run the verified loop.
  • reject_loom {feedback} — send it back with feedback.
  • resume_loom — retry without new feedback.
  • cancel_loom — halt it.
  • watch_loom — get woken as a chat turn on any state transition.

On your FIRST turn, call watch_loom for this loom so state changes reach you.

HARD RULE (the product's core invariant): you can steer/reject/resume/cancel, but
you can NEVER accept, promote, approve, or mark this loom "done". There is no tool
for that and there never will be — acceptance is a human click made outside this
chat. Do not claim you accepted it; do not imply the work is done. If the owner
asks you to accept it, tell them acceptance is theirs to make in the cockpit.`;

// Appended (never replacing) the "claude_code" preset for an ESCALATION session
// (docs/adaptive-verification.md §8's conversational-escalation surface) — the
// "Discuss with the orchestrator" chat on a `blocked` loom. Guidance only: the
// actual moat is the toolset (LOOM_ESCALATION_READONLY_TOOLS auto-run +
// LOOM_ESCALATION_DISALLOWED_TOOLS hard-blocked + answer_blocked human-gated via
// the PreToolUse guardrail). Reuses the steerer moat language: the agent can
// NEVER accept/promote/mark-done. Its ONE write is answer_blocked, which only
// lands after the human's explicit Approve click.
export const ESCALATION_SYSTEM_PROMPT = `You are embedded in a PARKED loom's escalation chat. The loop stopped BEFORE spending on the build because it could not stand up a way to VERIFY this work, and it refuses to guess. Your job is to talk it through with the human and distill the verification recipe.

You can OBSERVE this loom and inspect its project with read-only tools:
  • get_loom / read_bundle / list_looms — inspect state, objective, contract.
  • Read / Grep / Glob — inspect the project root (your working directory) to ground your advice in the real repo (package.json, test setup, entry points).

DISCUSS the verification method with the human. Explain the options plainly and help them choose the one that fits the deliverable:
  • a TEST/EVAL command — a command whose exit code proves the work (e.g. \`bun test\`), for a library/CLI/eval deliverable. Saved as the telar.yaml verifyCommand; a test suite is NEVER auto-spun as a dev server.
  • a DEV command — how to bring a runnable app up (e.g. \`bun run dev\`), for a web/app deliverable.
  • a RUNBOOK — optional free-text narrative for how to drive the app to reach the feature (accompanies a command; it can NOT resume the loom on its own).
  • a SERVERS recipe — a background-process setup, when the app needs services up first.

ONLY when the human has converged on a concrete answer, DISTILL it and call answer_blocked with the fields they settled on. That tool ASKS THE HUMAN TO APPROVE — you cannot resume a loom yourself; that human approval is required by design and IS the provenance stamp. After it resumes, tell them the loop is re-verifying and they can watch it in the cockpit.

HARD RULE (the product's core invariant): you can DISCUSS and, with the human's approval, answer the block — but you can NEVER accept, promote, approve, or mark this loom "done". There is no tool for that and there never will be — acceptance is a human click made outside this chat. Do not claim you accepted it; do not imply the work is done.
When you need to clarify something, ask it as a plain chat message and wait for the human's reply — never use a structured question/interactive tool; the chat has no UI to answer those.`;

// Composer-annotation half of doc §4's opt-in contract: a PER-TURN note (never
// persisted, never a session-level flag) telling the agent this specific message
// is the user's explicit Ultra request — the `ultra` tool's own description
// tells it to look for exactly this. Moved verbatim from route.ts's
// `ultraAnnotationNote` ternary; the ternary's CONDITION is what moved into the
// builders (`ultraAnnotated && !isEscalationSession` was a session-kind
// conditional, and it was the smallest one AC1 had to remove).
export const ULTRA_ANNOTATION_NOTE =
  "\n\n--- ULTRA REQUEST (this turn only) ---\nThe user's message below is Ultra-annotated: they explicitly asked for a large orchestrated/parallel run via the composer's Ultra chip. You may call the `ultra` tool THIS turn to author and launch a script. Do not call it on a later turn unless the user says \"ultra\" again or re-annotates.";

export const BROWSER_CONTROL_NOTE = `\n\n--- SHARED TELAR BROWSER ---
Telar's integrated Browser is a shared surface: its open tabs are visible to both you and the user. When the user refers to the browser, an open tab, or what they can see, do not claim that you lack access. First call browser_list_tabs, then browser_snapshot on the active tab. Use browser_take_screenshot when visual appearance matters. Navigation, clicks, typing, and tab mutations use the matching browser tools and remain subject to the session's permission policy. If no tab is open, say so plainly.`;

// --- The two live-context readers (moved verbatim from route.ts) -------------

// Keep the per-turn steerer append small: truncate a section to its last
// `max` bytes, prefixing an elision marker so the model knows it's a tail.
export function tail(s: string, max: number): string {
  return s.length <= max ? s : `…(truncated)…\n${s.slice(-max)}`;
}

// Guarded bundle read: a loom mid-flight may lack a file (objective/contract/
// steering) — a missing section is simply omitted, never an error.
export function safeRead(fn: () => string | null | undefined): string | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

// Dynamic per-turn context for a steerer session: recomputed every turn so the
// state + latest steering decisions are always fresh. Bounds each section so
// the append stays reasonable. Server-only (value core imports are fine here).
export function buildSteererContext(loomId: string): string {
  const loom = getLoom(loomId);
  const objective = safeRead(() => readBundleFile(loomId, "objective.md"));
  const contract = safeRead(() =>
    JSON.stringify(readContract(loomId).contract, null, 2),
  );
  const steering = safeRead(() => readBundleFile(loomId, STEERING_FILE));
  return [
    `\n\n--- LIVE LOOM CONTEXT (id ${loomId}, state: ${loom?.state ?? "unknown"}) ---`,
    objective && `# Objective\n${tail(objective, 4000)}`,
    contract && `# Verification Contract\n${contract}`,
    steering && `# Live steering decisions (append-only)\n${tail(steering, 4000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Dynamic per-turn context for an escalation session (parallel to
// buildSteererContext): recomputed every turn so blockedReason/blockedQuestion,
// the contract, and the deliverable-signal evidence are always fresh. Delegates
// the string assembly to loom-mcp's PURE formatEscalationContext (hermetically
// tested there) — this function only gathers the core-backed values. Guarded:
// each read fails safe to omission, never an error.
export function buildEscalationContext(loomId: string, root: string): string {
  const loom = getLoom(loomId);
  const assertions = safeRead(() => {
    const c = readContract(loomId).contract;
    return c ? JSON.stringify(c.assertions.map((a) => ({ type: a.type, description: a.description }))) : null;
  });
  // deriveDeliverableSignal is a bounded synchronous fs read (no LLM, no spawn)
  // — the same signal the pre-flight parked on, so the agent sees exactly which
  // verification substrates were checked and why none applied.
  const signalReason = (() => {
    try {
      return deriveDeliverableSignal(root, loom?.charter).reason;
    } catch {
      return undefined;
    }
  })();
  return formatEscalationContext({
    loomId,
    state: loom?.state,
    blockedReason: loom?.blockedReason,
    blockedQuestion: loom?.blockedQuestion,
    assertions: assertions ? (JSON.parse(assertions) as { type: string; description: string }[]) : undefined,
    signalReason,
  });
}

// Story 4.1 / AC2 — the per-turn COMPLETED ULTRA RUNS block. Reads the durable
// mailbox and hands it to the pure formatter in @/lib/ultra-wake; the string
// assembly lives there so it is unit-testable with no disk (the same split
// buildEscalationContext takes with formatEscalationContext).
//
// Server-only: `pendingUltraWakes` is a value import from @telar/core, exactly
// like getLoom above, and INV-4 enforces transitively that no "use client" file
// can reach this module.
export function buildUltraWakeContext(sessionId: string): string {
  return formatUltraWakeAppendix(pendingUltraWakes(sessionId));
}

// --- The appendix composers, one per kind -----------------------------------

// Story 4.1 — the wake block, composed through its OWN safeLiveContext call.
//
// TWO INDEPENDENT LIVE READS IN ONE COMPOSER, and that is new here: before this
// story no composer in this file ran more than one. They get SEPARATE wrappers
// on purpose, so a failure of either drops only its own block and neither can
// take the static prompt with it. A reader who finds one `safeLiveContext` and
// assumes it covers both will "simplify" them into one and re-couple exactly the
// failures the wrapper exists to keep apart.
//
// The injectable seam is `readWake`, NOT `read`: `read` is already occupied by
// buildSteererContext and is keyed by loomId, while this one is keyed by
// sessionId and is an orthogonal concern. Production never passes either.
function ultraWakeAppendix(sessionId?: string, readWake?: (sessionId: string) => string): string {
  return sessionId
    ? safeLiveContext(() => (readWake ?? buildUltraWakeContext)(sessionId))
    : "";
}

// The per-turn Ultra note, or "". A PURE function of the wire flag: it cannot
// fail, which is why it must survive a live-context failure (see
// safeLiveContext) rather than being wrapped in the same try.
export function ultraNote(ultraAnnotated: boolean): string {
  return ultraAnnotated ? ULTRA_ANNOTATION_NOTE : "";
}

// Story 4.2 / AC8 — THE SCRIPT-AUTHORING REFERENCE (CAP-3).
//
// SPELLED LOCALLY, not imported as core's `ProviderId`, so this module acquires
// no new core TYPE edge for a two-member union — exactly how
// `lib/spend-readout.ts` spells the same thing, and for the same reason.
type AppendixProvider = "claude" | "codex";

// IT IS STATIC AND NEEDS NO `safeLiveContext`, and that is worth saying out loud
// because EVERY other block added to this file since story 2.1 has been a live
// read. There is no disk here, no state root, and nothing that can throw — so
// wrapping it would only hide a programming error.
const ULTRA_AUTHORING_BLOCK = `\n\n--- ULTRA SCRIPT AUTHORING (CAP-3) ---\n${ULTRA_AUTHORING_REFERENCE}`;

// CLAUDE ONLY, and ABSENT ⇒ NOTHING. The ultra MCP server is constructed only on
// the Claude branch of `app/api/chat/route.ts`, and NFR-UW-8 fixes Ultra as
// Claude-first — so a Codex session would be handed several hundred lines of
// guidance for a tool it is never offered.
//
// The default of "absent means no reference" is what keeps every existing call
// site's behaviour byte-for-byte unchanged: the composers below all take
// `provider` as OPTIONAL, so only a caller that deliberately opts in sees any
// difference. The three callers that do are the three ultra-bearing builders in
// `lib/session-profiles.ts`, which are the only place `ctx.provider` exists.
export function ultraAuthoring(provider?: AppendixProvider): string {
  return provider === "claude" ? ULTRA_AUTHORING_BLOCK : "";
}

// Wraps the LIVE READ and nothing else, so a failure drops exactly the part
// that failed. Returns "" on any throw.
//
// The reads inside are already guarded individually (safeRead swallows,
// deriveDeliverableSignal is wrapped, getLoom returns null on a malformed or
// traversal id rather than throwing), so this is belt-and-suspenders — and the
// belt is what matters: these composers run PRE-STREAM now, where an escaped
// throw is a 500 with no SSE frame instead of an `error` event on an open
// stream. The static prompt is the moat language and must survive; only the
// per-turn freshness is expendable.
//
// The one failure resolveSessionProfile may still surface on the live path is
// an UNREGISTERED KIND, which means a surface forgot its side-effect import — a
// genuine programming error that should be loud. Everything else fails safe.
export function safeLiveContext(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

// project — no static prompt of its own. The appendix is the Ultra note plus,
// as of story 4.1, the completed-run block; both are "" on an ordinary turn,
// which is exactly what the route's old `ultraAnnotationNote ? {…append} : {…}`
// fallthrough produced. A plain session with no chip and no finished run has a
// byte-for-byte unchanged systemPrompt.
//
// STORY 4.2 MADE THAT LAST SENTENCE DELIBERATELY FALSE FOR CLAUDE. A Claude
// project session now carries the authoring reference on every turn (AC8), so
// its appendix is no longer "". The property SURVIVES UNCHANGED for Codex, where
// `provider` is not "claude" and the appendix is still "" — and that is the half
// worth stating, because the original sentence was about "a normal session's
// systemPrompt is byte-for-byte unchanged after the migration", which is a claim
// about the 2.2 migration and not a claim this story is allowed to break for
// every provider.
export function projectAppendix(opts: {
  ultraAnnotated: boolean;
  sessionId?: string;
  provider?: AppendixProvider;
  readWake?: (sessionId: string) => string;
}): string {
  return (
    ultraNote(opts.ultraAnnotated) +
    ultraWakeAppendix(opts.sessionId, opts.readWake) +
    ultraAuthoring(opts.provider)
  );
}

// planner — static guidance, the Ultra note, then the completed-run block. The
// wake block is the one part of this composer that CAN fail (it reads the ultra
// subtree), which is why it goes through safeLiveContext and the rest does not.
export function plannerAppendix(opts: {
  ultraAnnotated: boolean;
  sessionId?: string;
  provider?: AppendixProvider;
  readWake?: (sessionId: string) => string;
}): string {
  return (
    PLANNER_SYSTEM_PROMPT +
    ultraNote(opts.ultraAnnotated) +
    ultraWakeAppendix(opts.sessionId, opts.readWake) +
    ultraAuthoring(opts.provider)
  );
}

// steerer — static moat text + a per-turn live-context block + the Ultra note,
// in the route's own order.
//
// `loomId` is guarded rather than asserted non-null. The route's old call was
// `buildSteererContext(loomLink.loomId!)` under a comment claiming the id is
// always present when the kind is steerer; that holds for the turn-1 wire seed
// (which sets role and loomId together) but the RESUMED arm reads
// `existingChat?.role` and `existingChat?.loomId` independently, so the claim is
// about the store's shape rather than about this code. Degrading to the static
// prompt is the same fail-safe direction as safeLiveContext and costs nothing.
//
// `read` is injectable for the fail-safe test — production never passes it.
// `readWake` is its story-4.1 sibling, a SECOND and independent live read (see
// ultraWakeAppendix above for why they are not folded into one wrapper).
//
// STORY 4.2 APPENDED ONE MORE TERM, AND ITS POSITION IS NOW PART OF THE
// CONTRACT: the order is STEERER + LIVE + NOTE + WAKE + AUTHORING. The reference
// goes LAST, after the per-turn material, because it is static guidance whose
// freshness never changes while everything before it is recomputed every turn.
export function steererAppendix(opts: {
  loomId?: string;
  ultraAnnotated: boolean;
  sessionId?: string;
  provider?: AppendixProvider;
  read?: (loomId: string) => string;
  readWake?: (sessionId: string) => string;
}): string {
  const id = opts.loomId;
  const live = id ? safeLiveContext(() => (opts.read ?? buildSteererContext)(id)) : "";
  return (
    STEERER_SYSTEM_PROMPT +
    live +
    ultraNote(opts.ultraAnnotated) +
    ultraWakeAppendix(opts.sessionId, opts.readWake) +
    ultraAuthoring(opts.provider)
  );
}

// escalation — static moat text + a per-turn seed (blockedReason/question +
// contract + deliverable-signal evidence). NEVER an Ultra note AND, as of story
// 4.1, never a completed-run block either, for the identical reason: this
// profile HARD-DENIES all three ultra tools, so telling it a run finished is
// advertising an outcome to a surface that cannot act on it — the same class of
// mistake the note's own absence already names. Enforced by the signature, which
// carries neither `ultraAnnotated` nor `sessionId`, rather than by remembering.
//
// On the note specifically: the escalation surface is a narrow read-only discuss
// wall and is offered none of ultra's tools, so advertising the `ultra` tool to
// it would be an instruction to call something the same profile hard-denies.
// Measured from the route's own
// `ultraAnnotated && !isEscalationSession`, and it is the reason this signature
// has no `ultraAnnotated` at all — the absence is enforced by the type rather
// than remembered.
//
// STORY 4.2 ADDED NOTHING HERE, for the third time and the same reason: this
// profile hard-denies all three ultra tools, so a script-authoring reference
// would be several hundred lines teaching a surface to use something it cannot
// call. The signature carries no `provider` either, so AC8's "never on
// escalation" is enforced BY THE TYPE rather than by remembering.
export function escalationAppendix(opts: {
  loomId?: string;
  cwd: string;
  read?: (loomId: string, root: string) => string;
}): string {
  const id = opts.loomId;
  const live = id
    ? safeLiveContext(() => (opts.read ?? buildEscalationContext)(id, opts.cwd))
    : "";
  return ESCALATION_SYSTEM_PROMPT + live;
}
