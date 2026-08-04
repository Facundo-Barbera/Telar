// THE ULTRA CHILD'S PERMISSION POSTURE — the one thing a child may not do.
//
// WHAT WAS WRONG. An Ultra child runs `permissionMode: "bypassPermissions"`
// with the full editing toolset (runner.ts's ULTRA_CHILD_TOOLS: Read/Grep/Glob/
// Write/Edit/Bash) and, until this file, NO PreToolUse hook at all. A session
// turn gets one (apps/web/app/api/chat/route.ts's preToolUseGuardrail); a child
// got nothing. So the child was not merely un-prompted — which is intended, doc
// §3's fixed non-interactive posture — it was entirely OUTSIDE the permission
// system.
//
// That mattered because of a hole one layer below the MCP surface. Ultra
// children genuinely cannot call `mcp__ultra__*` or `mcp__loom__*`: runner.ts
// passes `mcpServers: {}` on the direct path and Ultra supplies no
// `extraMcpServers` on the engine.agent() path, so the only server a child ever
// sees is `out` (emit_result). But Telar's own HTTP control plane answers
// those same actions with NO authentication — `POST /api/looms/<id>/accept`
// takes no token, no origin check and no cookie, and stamps the acceptance as
// the human ("you"). A child holding Bash could therefore reach with `curl`
// exactly what the tool surface refuses it, including `ready → done`. AD-1 says
// "there is no agent-callable accept path"; that was true of the tools and
// false of the transport.
//
// WHY A DENYLIST HERE ANYWAY, AND WHAT IT IS NOT. This is a MITIGATION, not the
// boundary, and it must not be mistaken for one. A denylist over shell text is
// porous by construction — obfuscation defeats it, and anything that can write
// a file and run it can route around it. The durable fix is server-side:
// authenticate the control plane so an unauthenticated local process cannot
// accept a loom whoever it claims to be. This closes the ACCIDENTAL path (an
// agent that curls the API because the API is there and undefended) and buys
// nothing against a determined one. It is written down that way so nobody
// later reads this file as the moat.
//
// BASH IS NOT TAKEN AWAY, deliberately. Ultra is for editing code, not only
// reading it, and models are trained on the shell — removing Bash would cost
// real capability to buy a boundary this does not actually provide. The posture
// is "the full toolset, minus reaching Telar's own control plane".

import { makeGuardrailDecision } from "../guardrails";

/** Network clients a shell command could use to reach the control plane. The
 *  match is on the CLIENT, not on the URL alone, and that is the whole reason
 *  this rule is safe to run over a repo that contains the very paths it
 *  guards: `grep -rn "/api/ultra" apps/web` names a control-plane path and is
 *  ordinary, correct work for a child exploring this codebase. Only a command
 *  that both INVOKES a client and NAMES a control-plane route is denied. */
const NETWORK_CLIENT = /\b(curl|wget|xh|httpie|nc|ncat|telnet|lwp-request)\b/;

/** An in-line script doing the same thing without a dedicated client. Kept
 *  separate from NETWORK_CLIENT because the giveaway is the CALL, not the
 *  interpreter — `bun test` and `node build.js` must stay ordinary. */
const INLINE_REQUEST = /\b(fetch|urlopen|requests\.(get|post)|http\.request|XMLHttpRequest)\b/;

/** Telar's own mutating surface. Scoped to the routes that CHANGE something a
 *  human is supposed to own — acceptance and lifecycle (`/api/looms/...`), run
 *  launch (`/api/ultra`), and turn dispatch (`/api/chat`). Read-only routes are
 *  deliberately absent: a child reading `/api/ultra?sessionId=` learns nothing
 *  it could not read off disk, and denying it would be noise. */
const CONTROL_PLANE_ROUTE = /\/api\/(looms|ultra|chat)\b/;

/** True when a shell command looks like an attempt to drive Telar's own API
 *  rather than to do work in the repo. Exported for its test. */
export function reachesControlPlane(command: string): boolean {
  if (!CONTROL_PLANE_ROUTE.test(command)) return false;
  return NETWORK_CLIENT.test(command) || INLINE_REQUEST.test(command);
}

export const CONTROL_PLANE_DENIAL =
  "Telar's own HTTP API is not reachable from inside an Ultra run. A child agent " +
  "may edit this repository freely, but loom acceptance, loom lifecycle and run " +
  "launch belong to the human and to the session that owns them — an Ultra script " +
  "cannot accept a loom, start another run or dispatch a turn by calling the API. " +
  "If a script genuinely needs one of those, it belongs in the session that " +
  "launched the run, not in a child.";

// The SDK's hook shape, structurally. NOT imported from the Agent SDK on
// purpose: this module is pure predicate + message, it is unit-tested without a
// harness present, and runner.ts (which already imports the SDK) is where the
// value is handed over. Same posture harness-port.ts takes for tool
// descriptors — describe the shape, let the adapter own the import.
type PreToolUseHookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};
type PreToolUseHookOutput = {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

const deny = (reason: string): PreToolUseHookOutput => ({
  // `continue: true` even on a deny — the hook refuses THIS call, it does not
  // tear the child down. A killed child surfaces as a dead-agent null and reads
  // as a flaky run rather than as a refusal.
  continue: true,
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/** What a child needs to enforce the PROJECT's own guardrails: the root every
 *  protected path is resolved against, and the guardrail set itself. Optional
 *  at every layer above — a run with no project (tests, a script launched
 *  outside a chat) still gets the control-plane rule, which needs no context. */
export type UltraChildGuardContext = {
  root: string;
  guardrails: { disallowedTools: string[]; protectedPaths: string[] };
};

/** The PreToolUse hook every Ultra child runs under.
 *
 *  TWO RULES, and they answer to different owners. The control-plane rule is
 *  ULTRA'S OWN and applies to every run: no child drives Telar's API. The
 *  guardrail check is the PROJECT'S — the same `makeGuardrailDecision` a session
 *  turn runs (guardrails.ts), which until this change no child agent enforced at
 *  all: `protectedPaths` and `disallowedTools` were a session-only promise, and
 *  an Ultra child could rewrite the very files a project had declared off
 *  limits. A user who writes `protectedPaths: [".env"]` means it about agents,
 *  not about the surface that happens to be spawning them.
 *
 *  Project guardrails run FIRST: they are the user's explicit configuration,
 *  they are cheaper (a string compare before any filesystem work in the common
 *  case), and a denial from them names the project's own rule, which is the more
 *  useful message when both would fire. */
export function makeUltraChildGuard(context?: UltraChildGuardContext) {
  return async function ultraChildGuard(
    input: PreToolUseHookInput,
  ): Promise<PreToolUseHookOutput> {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const toolName = input.tool_name ?? "";
    const toolInput = input.tool_input ?? {};

    if (context) {
      const decision = makeGuardrailDecision(context, context.root, toolName, toolInput);
      if (decision.behavior === "deny") return deny(decision.message);
    }

    if (toolName !== "Bash") return { continue: true };
    const command = toolInput.command;
    if (typeof command !== "string" || !reachesControlPlane(command)) {
      return { continue: true };
    }
    return deny(CONTROL_PLANE_DENIAL);
  };
}

/** The context-free guard — control-plane rule only. Kept as the default for a
 *  run that has no project to speak of. */
export const ultraChildGuard = makeUltraChildGuard();
