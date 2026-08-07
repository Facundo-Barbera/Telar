// ISSUE #28 — "phantom declines": an agent told "The user doesn't want to take
// this action right now" when the user was never asked and saw no prompt.
//
// THE CAUSE, and why it only ever showed up under sub-agents. `full-access`
// maps to the SDK's `bypassPermissions`, under which the SDK approves the MAIN
// turn's tool calls itself and never invokes canUseTool — so a full-access
// session genuinely was prompt-free, and the bug was invisible there. But every
// tool a SUB-AGENT calls is deliberately routed through canUseTool (so that
// protectedPaths/disallowedTools still gate it), and canUseTool had no mode
// check whatsoever. It opened a pending approval and awaited a human who had
// been told this session needs no approvals, in a session where no card was
// coming. The call sat blocked, something upstream gave up on it, and the model
// was told — in the CLI's own words, which Telar cannot rewrite — that the user
// had refused. Ultras never reproduced it because their agents are spawned
// in-process by the executor and never touch this channel at all.
//
// WHY A SOURCE SCAN. canUseTool is a closure defined inside the route's
// ReadableStream, with no export and no seam, and this repo has no harness that
// can drive a live SDK turn (the same constraint compaction-wire.test.ts and
// command-keys-wiring.test.ts work under). What can be pinned is that the
// branch exists, that the guardrail still precedes it, and — the half that
// actually matters — that the accept moat is NOT inside it.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

// The short-circuit, as one normalized string: the source is wrapped across
// lines by the formatter, so collapse whitespace before matching rather than
// pinning a particular line break.
const canUseToolSource = (() => {
  const start = route.indexOf("const canUseTool = async (");
  expect(start).toBeGreaterThan(-1);
  const end = route.indexOf("const preToolUseGuardrail", start);
  expect(end).toBeGreaterThan(start);
  return route.slice(start, end);
})();
const flat = canUseToolSource.replace(/\s+/g, " ");

describe("#28 — full access does not ask a sub-agent's caller for permission", () => {
  test("canUseTool short-circuits on full-access before opening a pending approval", () => {
    expect(flat).toContain('runtimeMode === "full-access"');
    // …and it RETURNS on that branch. A mode check that only logs would satisfy
    // a bare `toContain` while leaving the call blocked exactly as before.
    const branch = flat.slice(flat.indexOf('runtimeMode === "full-access"'));
    expect(branch.slice(0, 400)).toContain('return { behavior: "allow"');
  });

  test("the short-circuit is reached BEFORE the interactive prompt is created", () => {
    const modeAt = flat.indexOf('runtimeMode === "full-access"');
    const pendingAt = flat.indexOf("createPending(");
    expect(modeAt).toBeGreaterThan(-1);
    expect(pendingAt).toBeGreaterThan(-1);
    // Ordering IS the fix. Below createPending it would allow the call only
    // after already having opened the approval nobody can answer.
    expect(modeAt).toBeLessThan(pendingAt);
  });

  test("the guardrail still runs first, so full access never widens a guardrail", () => {
    const guardrailAt = flat.indexOf("makeGuardrailDecision(");
    const modeAt = flat.indexOf('runtimeMode === "full-access"');
    expect(guardrailAt).toBeGreaterThan(-1);
    expect(guardrailAt).toBeLessThan(modeAt);
    // The deny must be acted on between the two, not merely computed.
    const between = flat.slice(guardrailAt, modeAt);
    expect(between).toContain('guardrail.behavior === "deny"');
  });

  // THE HALF THAT PROTECTS THE MOAT. Telar diverges from the reference
  // implementation (t3code's ClaudeAdapter, which allows full-access with no
  // exceptions) precisely here: §M.6 requires a human's click on start_loom and
  // answer_blocked in EVERY permission mode. If either name is ever dropped
  // from this condition, full access silently becomes the one mode in which an
  // agent can start a loom — spending money autonomously — with no human in it.
  test("start_loom and answer_blocked are EXCLUDED from the short-circuit", () => {
    // SCOPED TO THE CONDITION, NOT TO THE REGION. Measured: slicing from the
    // mode check down to createPending( passes with BOTH exclusions deleted,
    // because the stored-rules skip that sits in between carries the very same
    // two `toolName !== …` clauses for its own reasons. An assertion that any
    // nearby line can satisfy is not an assertion. So take only the text
    // BETWEEN the mode check and the `) {` that closes its own if-condition.
    const at = flat.indexOf('runtimeMode === "full-access"');
    expect(at).toBeGreaterThan(-1);
    const rest = flat.slice(at);
    const condition = rest.slice(0, rest.indexOf(") {"));
    for (const name of ["LOOM_START_TOOL", "LOOM_ANSWER_BLOCKED_TOOL"]) {
      expect(condition).toContain(`toolName !== ${name}`);
    }
  });
});

// ── The Codex half ─────────────────────────────────────────────────────────
//
// A CODEX session has no PreToolUse hook — that is an SDK concept — so
// onCodexDynamicTool is the ONLY gate its tool calls ever pass. It used to
// return "accept" for every non-browser namespace on its first line, while
// `codexToolNamespaces` hands Codex the full loom toolset. So start_loom, the
// one action in this toolset that spends money autonomously, was auto-accepted
// in every runtime mode with no human in it. The handlers cannot catch this:
// `by` is server-resolved, but nothing in loom-mcp.ts requires a click.
//
// INV-1g pins the Claude half of AD-1 and knows nothing about this path, which
// is precisely how the hole survived. These are its Codex counterpart.
const codexDynamicToolSource = (() => {
  const start = route.indexOf("const onCodexDynamicTool = async (");
  expect(start).toBeGreaterThan(-1);
  // The DECLARATION, not the bare name — the name also appears inside this
  // callback's own explanatory comment, and anchoring on it truncated the slice
  // to the comment alone, which made every assertion below vacuously fail (and
  // would just as happily have made them vacuously pass).
  const end = route.indexOf("const codexToolNamespaces = [", start);
  expect(end).toBeGreaterThan(start);
  return route.slice(start, end).replace(/\s+/g, " ");
})();

describe("AD-1 §M.6 — the accept moat holds on the Codex path too", () => {
  test("the moat is decided BEFORE the browser-namespace filter that returns accept", () => {
    const moatAt = codexDynamicToolSource.indexOf("isMoatTool =");
    const filterAt = codexDynamicToolSource.indexOf(
      "req.namespace !== CODEX_BROWSER_TOOL_NAMESPACE",
    );
    expect(moatAt).toBeGreaterThan(-1);
    expect(filterAt).toBeGreaterThan(-1);
    // Ordering IS the fix: below the filter, a loom call has already returned.
    expect(moatAt).toBeLessThan(filterAt);
  });

  test("both moat tools are named, via the canonical mcp__<ns>__<tool> spelling", () => {
    const at = codexDynamicToolSource.indexOf("isMoatTool =");
    const decl = codexDynamicToolSource.slice(at, codexDynamicToolSource.indexOf(";", at));
    for (const name of ["LOOM_START_TOOL", "LOOM_ANSWER_BLOCKED_TOOL"]) {
      expect(decl).toContain(name);
    }
  });

  test("a moat tool escapes NONE of the three accept paths", () => {
    // Each of these would independently re-open the hole, and each is a
    // different mechanism: the namespace filter, the runtime-mode delegation,
    // and a persisted always-allow rule.
    expect(codexDynamicToolSource).toContain("if (!isMoatTool) {");
    expect(codexDynamicToolSource).toContain(
      '!isMoatTool && (runtimeMode === "full-access" || runtimeMode === "auto")',
    );
    expect(codexDynamicToolSource).toContain("!isMoatTool && readRules(project)");
  });

  test("a moat tool's approval is never persisted as a standing rule", () => {
    // The write half. Without it the readRules skip is load-bearing alone, and
    // a rule sits on disk claiming an authorization the human never gave.
    expect(codexDynamicToolSource).toContain(
      "decision.always && !isMoatTool",
    );
  });
});
