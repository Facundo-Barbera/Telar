// Ultra's REAL agent runner (cut U4-A, doc §3/§4). Binds the injected
// surface's agent() call to a real SDK session.
//
// Doc §2/§3 are explicit that Ultra "wraps engine agent()" so it inherits the
// process-wide concurrency gate "for free". That gate is now admission.ts's
// controller (AD-17) — one visible, configurable ceiling with per-class shares
// — and it is still only ever entered from inside engine.agent()'s own
// acquire/release wrapper. So for the `schema`-present path (below) this runner
// calls engine.agent() directly — the schema'd branch was already a
// near-duplicate of engine.agent()'s own wiring, so delegating is strictly less
// code and is what actually joins the shared gate. Those calls declare
// `admissionClass: "ultra"`, so they take a weighted share and, once anyone is
// queued, cede a freed slot to an entitled verification waiter ahead of them.
// The fixed child posture (doc §3: no per-agent permission knob,
// ULTRA_CHILD_TOOLS only, non-interactive/fail-closed) is expressed through
// engine.agent()'s own `tools` + `restrictTools: true` opts — nothing about the
// posture is diluted by sharing the implementation.
//
// The one thing engine.agent() structurally cannot do is doc §3's OTHER
// `agent()` contract half: `schema` absent -> no tool is forced, return the
// model's FINAL TEXT instead (the last non-empty assistant text block) —
// engine.ts's `AgentOpts.schema` is required, always forces a typed
// `emit_result`. That case keeps its own minimal query() loop below.
// executor.ts's current DI wiring always supplies a schema (a documented U3
// passthrough shim, PASSTHROUGH_SCHEMA), so in practice EVERY real Ultra
// call today takes the gated engine.agent() path; the schema-less loop is
// reachable only via a script/caller that invokes this runner directly
// without a schema — and, having no engine.agent() equivalent to delegate
// to, it does NOT join the shared gate (scoped to just this one narrow,
// currently-unused-by-executor.ts branch).
//
// Two doctrine-mandated differences from a loom's engine.agent() call still
// apply on both paths:
//
//   1. NO soft model default, ever. engine.agent() falls back to `"sonnet"`
//      when `opts.model` is omitted; Ultra's contract is the opposite — a
//      call without an explicit model is a MissingModel control signal
//      (enforced upstream in executor.ts's agentFn before a call ever
//      reaches here; this runner ALSO refuses, defense-in-depth, so the
//      contract holds even if it's ever invoked directly, and even though
//      we always pass an explicit `model` through to engine.agent() so its
//      own fallback branch is never actually reached).
//   2. A FIXED, non-optional child posture (doc §3): every child gets the
//      SAME tool surface a normal Telar session agent has — Read/Grep/Glob/
//      Write/Edit/Bash — with NO restrictTools knob, no per-agent widen (doc
//      §3: "no per-agent permission knob... scripts narrow work, never grant
//      capability"). Enforcement is vendor-shipped: `tools` availability
//      restriction (not just `allowedTools` auto-approval — under
//      `bypassPermissions` that alone doesn't gate availability, exactly the
//      engine.ts note this mirrors) plus `permissionMode: "bypassPermissions"`
//      so nothing PAUSES for interactive approval — an action outside the
//      fixed toolset is simply unavailable, the fail-closed shape doc §3
//      calls for, never a hang.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agent as engineAgent, accountEnv, type EngineEvent } from "../engine";
import { claudeExecutableOptions } from "../claude-executable";
import { makeUltraChildGuard, type UltraChildGuardContext } from "./child-guard";

// The child's PreToolUse registration, in the SDK's matcher shape. Built ONCE
// per call and used on BOTH legs below (the engine.agent() delegation and the
// schema-less query()), because a guard covering one of the two paths is a
// guard with a documented way around it — and which leg a call takes is decided
// by whether the SCRIPT passed a schema, which is not a security decision.
//
// The guard closes over the run's project context when there is one; without it
// the control-plane rule still applies (see child-guard.ts).
const childHooks = (context?: UltraChildGuardContext) => ({
  PreToolUse: [{ hooks: [makeUltraChildGuard(context)] }],
});
import type { AccountProfile } from "../schemas";
import { MissingModel } from "./signals";

// The normal Telar session tool surface for a child agent (doc §3's "same
// tool surface a normal Telar session agent has for that provider"). Defined
// here, NOT imported from the loom executor's BASE_TOOLS — Ultra must not
// couple to loom internals — but intentionally the same values. ALWAYS
// enforced: there is no restrictTools knob and no per-agent override (doc
// §3's "no per-agent permission knob"). `opts.isolation` (doc §3: a fresh
// worktree for a parallel mutator) narrows WHERE these tools may write, via
// `cwd` — that worktree wiring is a later cut (surface.ts); this fixed
// toolset is the WHAT, unconditional either way.
export const ULTRA_CHILD_TOOLS = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"] as const;

/** How many agent turns a child gets when the script does not say
 *  (surface.ts's `UltraAgentOpts.maxTurns` overrides it per call).
 *
 *  WHY THERE IS A CEILING HERE AT ALL, when a session has none. A session is
 *  watched by a human with a Stop button; agent 7 of 12 in a fan-out is watched
 *  by nobody. Run-level Stop exists, but it needs someone to notice — so for a
 *  child this is the only bound that acts on its own, and removing it means a
 *  stuck child loops until the account's quota stops it.
 *
 *  WHY IT ROSE FROM 30. Thirty was chosen when Ultra was read-mostly, and it is
 *  a plausible budget for "read one file, answer in a sentence". Ultra is also
 *  for editing code, and an edit/run-tests/repair cycle spends turns several
 *  times faster; a child that runs out does not fail loudly, it settles as a
 *  dead agent, having possibly already changed files. 200 keeps a runaway
 *  bounded while no longer cutting off ordinary work — and a script that knows
 *  its own shape should say so rather than lean on this. */
export const ULTRA_CHILD_MAX_TURNS = 200;

export type UltraRunnerOpts = {
  model: string; // REQUIRED — no fallback, ever (doc §4)
  schema?: z.ZodObject<z.ZodRawShape>; // present -> forced emit_result; absent -> final-text capture
  label?: string; // display-only; never reaches the SDK
  // Reasoning effort, forwarded to the SDK on BOTH legs below. Not display-only
  // — see surface.ts's UltraAgentOpts note for why this used to be dropped and
  // why that was a placebo control.
  effort?: string;
  cwd?: string; // project root, or the opts.isolation worktree (doc §3) — narrows WHERE, never WHETHER
  // The PROJECT's own guardrails (protectedPaths / disallowedTools), enforced on
  // this child through the PreToolUse hook. Absent = the control-plane rule
  // only. Carried explicitly rather than derived from `cwd` because the two
  // diverge the moment `opts.isolation` lands: a worktree child has a different
  // cwd but the SAME project rules, resolved against the project's own root.
  guardrails?: UltraChildGuardContext;
  account?: AccountProfile; // routes env exactly like engine.ts's accountEnv (doc §2: inherited "for free")
  maxTurns?: number;
  abort?: AbortController;
  onEvent?: (e: EngineEvent) => void;
};

// Same cap/shaping idiom as engine.ts's toolOutputText/capToolInput (house
// pattern), reimplemented here in miniature — self-contained, no import of
// engine.ts's unexported helpers.
const TOOL_OUTPUT_CAP = 4096;
const capText = (s: string): string =>
  s.length > TOOL_OUTPUT_CAP ? s.slice(0, TOOL_OUTPUT_CAP) + "…[truncated]" : s;
const toolOutputText = (content: unknown): string => {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b: unknown) => {
              const block = b as { text?: unknown };
              return typeof block?.text === "string" ? block.text : JSON.stringify(block);
            })
            .join("")
        : JSON.stringify(content);
  return capText(raw);
};

// One live SDK session. Returns the schema'd emit_result value (or null — the
// engine's own "no emit = null" contract, never inferred), OR — schema-less —
// the final assistant text (or null if the model never emitted any), doc §3.
export async function runUltraAgent(promptText: string, opts: UltraRunnerOpts): Promise<unknown> {
  if (!opts.model) throw new MissingModel(opts.label); // defense-in-depth; executor.ts already gates this

  // schema present -> delegate to engine.agent() itself (see file header):
  // this is what actually joins the shared admission gate (admission.ts), since
  // that gate is only ever entered from inside engine.agent()'s own
  // acquire/release wrapper. `restrictTools: true` + `tools:
  // ULTRA_CHILD_TOOLS` reproduce the exact fixed child posture the loop below
  // enforces by hand — no dilution from sharing the implementation.
  if (opts.schema) {
    return engineAgent(promptText, {
      schema: opts.schema,
      // Ultra's weighted share of the process ceiling. Precedence, not a
      // reservation: nothing is held back for verification while Ultra runs, so
      // a pure-Ultra workload can still borrow the whole ceiling.
      admissionClass: "ultra",
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      cwd: opts.cwd ?? process.cwd(),
      maxTurns: opts.maxTurns ?? ULTRA_CHILD_MAX_TURNS,
      tools: [...ULTRA_CHILD_TOOLS],
      restrictTools: true,
      hooks: childHooks(opts.guardrails),
      ...(opts.account ? { account: opts.account } : {}),
      ...(opts.abort ? { abort: opts.abort } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
  }

  // schema absent -> no engine.agent() equivalent (its `schema` is required);
  // final-text capture keeps its own minimal query() loop (file header: the
  // one path that does not join the shared gate).
  let lastText: string | null = null;

  // Maps tool_use id -> tool name so a later tool_result (which only carries
  // tool_use_id) can be labelled with the tool it came from — same idiom as
  // engine.ts's agent().
  const toolNames = new Map<string, string>();

  for await (const msg of query({
    prompt: promptText,
    options: {
      cwd: opts.cwd ?? process.cwd(),
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort as never } : {}),
      maxTurns: opts.maxTurns ?? ULTRA_CHILD_MAX_TURNS,
      permissionMode: "bypassPermissions",
      env: accountEnv(opts.account),
      // Same resolution engine.agent() applies — this branch calls query()
      // directly, so it needs it directly too.
      ...claudeExecutableOptions(),
      // …and the same child guard, for the same reason.
      hooks: childHooks(opts.guardrails) as never,
      ...(opts.abort ? { abortController: opts.abort } : {}),
      // Fixed child posture (doc §3) — ALWAYS restricted, no knob. Under
      // bypassPermissions, `allowedTools` alone does not gate availability
      // (engine.ts's own documented gotcha); `tools` is what actually
      // confines the built-in preset to ULTRA_CHILD_TOOLS.
      tools: [...ULTRA_CHILD_TOOLS],
      mcpServers: {},
      // Telar owns the MCP surface for a child exactly like engine.ts's
      // agent(): only what we pass here is used, never the repo's own
      // .mcp.json / user settings / plugin MCP.
      strictMcpConfig: true,
      allowedTools: [...ULTRA_CHILD_TOOLS],
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") {
      opts.onEvent?.({ type: "session", sessionId: (msg as { session_id: string }).session_id });
    } else if (msg.type === "assistant") {
      for (const block of (msg as { message?: { content?: unknown[] } }).message?.content ?? []) {
        const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          lastText = b.text; // running "final text" — the LAST block wins (doc §3)
          opts.onEvent?.({ type: "text", text: b.text });
        }
        if (b.type === "tool_use" && b.id && b.name) {
          toolNames.set(b.id, b.name);
          opts.onEvent?.({ type: "tool", name: b.name, input: b.input });
        }
      }
    } else if (msg.type === "user") {
      for (const block of (msg as { message?: { content?: unknown[] } }).message?.content ?? []) {
        const b = block as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (b?.type === "tool_result") {
          opts.onEvent?.({
            type: "tool-result",
            name: toolNames.get(b.tool_use_id ?? ""),
            ok: !b.is_error,
            output: toolOutputText(b.content),
          });
        }
      }
    } else if (msg.type === "result") {
      const r = msg as { subtype: string; total_cost_usd?: number; num_turns?: number };
      opts.onEvent?.({ type: "result", subtype: r.subtype, costUsd: r.total_cost_usd, turns: r.num_turns });
    }
  }

  return lastText;
}

// The DI seam type — `StartUltraOpts.agent` in executor.ts. Named
// `EngineAgentFn` for continuity with the earlier cuts' DI seam name (an
// injectable "the real thing" fn tests replace with a fake); it is no longer
// literally `typeof engine.agent` (a schema'd call now delegates to
// engine.agent() internally, see the file header, but the DI seam itself
// stays this runner's own shape-compatible signature).
export type EngineAgentFn = typeof runUltraAgent;
