// M11 finding-1 — the escalation chat opens with a REAL agent turn, not a
// render-only greeting (docs/m11-discuss-iteration.md §1). This module is the
// PURE, dependency-free seam shared by the client (session-view.tsx) and the
// server (route.ts) so both agree on the kickoff contract AND it is unit-
// testable without importing either heavy module.
//
// THE FLOW (and the moat it preserves):
//   1. The human clicks "Discuss with the orchestrator" — the SACRED no-auto-
//      start rule (discuss-escalation.tsx) means SessionView only MOUNTS after
//      that click. Nothing here runs before it.
//   2. On mount, SessionView auto-fires exactly ONE hidden kickoff turn whose
//      wire `message` is ESCALATION_KICKOFF_SENTINEL. No user bubble is
//      rendered — the human never "said" anything; the agent speaks first.
//   3. route.ts recognizes the sentinel on a FRESH escalation session and
//      swaps it for ESCALATION_KICKOFF_PROMPT, so the model is driven purely
//      from ESCALATION_SYSTEM_PROMPT + buildEscalationContext (the seeded
//      blocked context) and its FIRST assistant message is genuine analysis
//      proposing a concrete verification method.
//   4. The proposal still lands ONLY through the human-approved answer_blocked
//      tool — the kickoff may CALL it, but execution waits on the permission
//      card (route.ts §M.6 + loom-mcp.ts). This module never touches that.

// The sentinel carried as the wire `message` of the auto-fired first turn.
// Opaque on purpose: it is never rendered (the client suppresses the user
// bubble) and route.ts always substitutes it before the model sees it, so a
// human could never type this by accident and reach the kickoff branch.
export const ESCALATION_KICKOFF_SENTINEL = "__telar_escalation_kickoff__";

// The canonical instruction route.ts feeds the model IN PLACE OF the sentinel.
// Server-authored (not client-injectable) so the kickoff wording lives next to
// the moat. The heavy lifting is already in ESCALATION_SYSTEM_PROMPT + the
// per-turn buildEscalationContext seed; this just tells the model the human
// just opened the discussion and it should OPEN with a proposal.
export const ESCALATION_KICKOFF_PROMPT =
  "The human just opened this escalation to discuss how to verify this blocked loom. Using the blocked context above (the blocked reason/question, the contract, and the deliverable signal), OPEN by analyzing it in one or two sentences and PROPOSING one concrete verification method — name the specific command (e.g. a verifyCommand like `bun test`, or a dev command to bring the app up) and say briefly why it fits this deliverable. If you are confident it is right, tell the human that approving will submit it via answer_blocked so the loom resumes. Keep it concise; do not restate these instructions.";

// SERVER: is THIS POST the auto-fired escalation kickoff? True only for a wire
// role of "escalation", a brand-new session (no resume target — a kickoff is
// always turn 1), and the exact sentinel message. Any real user turn (a typed
// reply on a resumed session, or any other text) is false and untouched.
export function isEscalationKickoff(
  role: string | undefined,
  sessionId: string | null | undefined,
  message: unknown,
): boolean {
  return (
    role === "escalation" && !sessionId && message === ESCALATION_KICKOFF_SENTINEL
  );
}

// SERVER: the effective prompt the model runs for this turn — the canonical
// kickoff instruction for a recognized kickoff, otherwise the caller's message
// verbatim. Byte-identical to the input for every non-kickoff turn, so no
// existing (planner/steerer/plain) path changes.
export function resolveEscalationMessage(
  role: string | undefined,
  sessionId: string | null | undefined,
  message: string,
): string {
  return isEscalationKickoff(role, sessionId, message)
    ? ESCALATION_KICKOFF_PROMPT
    : message;
}

// CLIENT: should SessionView auto-fire the one-shot kickoff on this render?
// Fires only for a fresh escalation surface (escalation prop set, no session
// id yet, empty transcript) that has not already fired. The `alreadyFired`
// ref guard is what makes it one-shot across re-renders/remounts-with-session.
export function shouldFireEscalationKickoff(opts: {
  escalation?: boolean;
  sessionId: string | null;
  messagesLength: number;
  alreadyFired: boolean;
}): boolean {
  return (
    !!opts.escalation &&
    !opts.sessionId &&
    opts.messagesLength === 0 &&
    !opts.alreadyFired
  );
}
