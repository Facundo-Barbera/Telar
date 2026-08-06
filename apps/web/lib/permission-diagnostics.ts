// #28 DIAGNOSTICS — opt-in, off unless TELAR_DEBUG_PERMISSIONS=1.
//
// WHAT THIS EXISTS TO DECIDE. Agents are periodically told
//
//     "The user doesn't want to take this action right now. STOP what you are
//      doing and wait for the user to tell you how to proceed."
//
// when the user was never asked and saw no prompt. Three explanations have been
// eliminated by reading code, and the fourth cannot be settled that way:
//
//  1. NOT a permission denial. That sentence lives in the SDK's bundled CLI
//     binary, in the interrupt cluster — its string-table neighbours are
//     "[Request interrupted by user]", "[Request interrupted by user for tool
//     use]" and "API Error: Request was aborted." It is what the CLI writes
//     into a pending tool_use when a turn is CANCELLED. telar cannot rewrite
//     it; it is compiled into a binary.
//  2. NOT an unanswered permission request. It was observed in `full-access`,
//     where canUseTool is never consulted at all.
//  3. NOT a client disconnect. Turns run detached (lib/chat-runs.ts) and
//     route.ts:776 keeps consuming after the client goes away.
//
// What is left is: something calls Stop, or the interrupt is SDK-internal. That
// is a question about a RUNNING process, not about the source, so it needs
// runtime evidence — hence this file rather than more reading.
//
// THE DECIDING OBSERVATION. When a phantom decline appears, look for a STOP
// line at the same moment:
//   · a STOP line  ⇒ something in telar is calling Stop that should not be, and
//                    `via` and `stack` say what.
//   · no STOP line ⇒ the interrupt is SDK-internal, and the MCP-reconnect
//                    hypothesis is the live one.
//
// WHY IT IS GATED rather than always-on: this logs every tool call a session
// makes, which during parallel agent work is thousands of lines an hour, and
// tool INPUTS can carry file contents and secrets. Diagnostics that cost
// nothing to leave on are diagnostics nobody turns off.

const ENABLED = process.env.TELAR_DEBUG_PERMISSIONS === "1";

/** Monotonic-ish tag so two lines from the same millisecond stay orderable. */
let seq = 0;

function emit(kind: string, fields: Record<string, unknown>): void {
  if (!ENABLED) return;
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  // One line per event, grep-friendly, no multi-line payloads: this is read by
  // correlating timestamps against a transcript, not by a log viewer.
  console.log(`[TELAR#28] ${new Date().toISOString()} #${++seq} ${kind} ${parts.join(" ")}`);
}

/** Every canUseTool entry. Its ABSENCE beside a decline is the finding — it
 *  means the SDK never asked telar, so telar did not decide anything. */
export function logPermissionCheck(toolName: string, agentID: string | undefined): void {
  emit("CANUSETOOL", { tool: toolName, agent: agentID ?? "MAIN" });
}

/** How telar answered, so a real telar denial is never mistaken for a phantom.
 *  telar's own denial texts are distinct from the CLI's interrupt sentence, and
 *  this records which one the model actually got. */
export function logPermissionOutcome(
  toolName: string,
  behavior: string,
  reason: string | undefined,
): void {
  emit("DECIDED", { tool: toolName, behavior, reason: reason ?? "user" });
}

/** Every Stop that reaches the run registry — the load-bearing one. `via` names
 *  the caller so a Stop nobody clicked is attributable rather than merely
 *  visible, and the stack is captured because the three known callers are all
 *  explicit user actions, so a fourth would be the bug itself. */
export function logStop(key: string, found: boolean, via: string): void {
  emit("STOP", {
    key,
    found,
    via,
    stack: ENABLED ? (new Error().stack ?? "").split("\n").slice(2, 6).join(" | ") : undefined,
  });
}

/** Turn boundaries, so a decline can be placed relative to one. telar's MCP
 *  servers are constructed inside query() options and are therefore per-turn:
 *  they tear down and rebuild at every boundary, which is the suspected trigger
 *  for an SDK-side tool-surface interrupt. */
export function logTurnBoundary(phase: "start" | "end", runId: string, sessionId: string | null): void {
  emit("TURN", { phase, runId, session: sessionId ?? "new" });
}

export const permissionDiagnosticsEnabled = ENABLED;
