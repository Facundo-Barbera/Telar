// The SDK hooks a Claude turn registers. Lifted out of app/api/chat/route.ts,
// where they sat in the middle of a 2,500-line handler and were easy to read as
// incidental plumbing. They are not: `preToolUse` is HALF OF THE MOAT (AD-1's
// "enforced twice"), and the compaction pair is the only thing that tells a
// client the harness compacted on its own.
//
// Each is a factory rather than a bare function, because each closes over
// exactly what it needs and nothing else — `preToolUse` over the resolved
// profile alone, the compaction pair over this turn's two sinks. That is the
// property worth having in a separate file: the closure surface is now visible
// in the signature instead of being whatever the enclosing 2,500 lines happened
// to have in scope.

import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { SessionProfile } from "@telar/core";
import type { CompactionEventName, CompactionFacts } from "@/lib/compaction";
import { LOOM_ANSWER_BLOCKED_TOOL, LOOM_START_TOOL } from "@/lib/loom-mcp";
import { makeGuardrailDecision } from "@/lib/permissions";
import { AGENT_SPAWN_TOOL_CANDIDATES } from "@/lib/transcript";

/**
 * PreToolUse — the second of AD-1's two enforcement points.
 *
 * It exists because the SDK can approve a call WITHOUT ever invoking
 * `canUseTool`: permission mode "auto"/"acceptEdits", the SDK's own classifier,
 * and the pre-approval fast path all bypass it. Hooks fire before any of those
 * decisions are finalized, so this is the last place a call can be refused or
 * its input rewritten.
 */
export function makePreToolUseGuardrail(sessionProfile: SessionProfile) {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    // Same profile-driven source as canUseTool's own branch — one resolved
    // guardrail set, two enforcement points. If these two ever read different
    // values, the belt-and-suspenders becomes a belt and a decoration.
    const decision = makeGuardrailDecision(
      sessionProfile,
      sessionProfile.cwd,
      input.tool_name,
      toolInput,
    );
    if (decision.behavior === "deny") {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      };
    }
    // §M.6 / §6 moat guard: mcp__loom__start_loom dispatches a real loom — the
    // one action in this whole toolset that spends money autonomously — and "no
    // human starts a Loom alone" must hold in EVERY permission mode, not just
    // "default". It is deliberately never in `allowedTools`, but that alone only
    // stops the SDK's pre-approval fast path. Returning `ask` here force-routes
    // it back through the interactive canUseTool permission card every single
    // time; the human clicking Approve on that card IS the §M.6 human-approved
    // provenance stamp startLoomFromBundle's `by` records.
    //
    // The SAME §M.6 hard-route covers answer_blocked (M11.3): the
    // conversational-escalation write commits a viability-making verification
    // recipe that resumes a parked loop, so — like start_loom — it must force the
    // interactive card in every mode, and the human's Approve click is the
    // provenance stamp answerBlocked's `by` records.
    if (input.tool_name === LOOM_START_TOOL || input.tool_name === LOOM_ANSWER_BLOCKED_TOOL) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason:
            input.tool_name === LOOM_START_TOOL
              ? "Starting a loom always requires the human's explicit approval (docs/loom-model.md §M.6)."
              : "Answering a blocked loom always requires the human's explicit approval (docs/loom-model.md §M.6).",
        },
      };
    }
    // Mirror canUseTool's own AGENT_SPAWN_TOOL_CANDIDATES stripping: this hook
    // fires even for a Task/Agent spawn that auto/acceptEdits mode approved
    // WITHOUT ever calling canUseTool — the only place left that can strip a
    // model-supplied `mode` ("bypassPermissions" skips the subagent's own
    // permission checks entirely) or `isolation` ("remote" moves it off-box)
    // before either reaches the SDK. `updatedInput` on a PreToolUse hook's
    // output replaces the tool's input the same way canUseTool's own does.
    if (
      (AGENT_SPAWN_TOOL_CANDIDATES as readonly string[]).includes(input.tool_name) &&
      ("mode" in toolInput || "isolation" in toolInput)
    ) {
      const { mode: _mode, isolation: _isolation, ...safeInput } = toolInput;
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: safeInput },
      };
    }
    return { continue: true };
  };
}

/**
 * The client's "compacting…" indicator, sourced from the SDK's own
 * PreCompact/PostCompact hooks rather than from this route's own on-demand
 * `compact` flag alone — the SDK fires them for its OWN auto-compaction too,
 * whenever a normal turn is about to overrun its context window, and that case
 * has no `compact: true` on the wire at all. One pair of hooks covers both
 * origins; `input.trigger` ("manual" | "auto") is how the client tells them
 * apart, the same enumeration as HarnessEvent's compact_start/compact_end.
 *
 * Always registered, never conditional on `compact` — see PARITY RULE / AD-11's
 * neighbor concern: an auto-compaction the client never learns about is a
 * silent-degradation shape by a different name.
 */
export function makeCompactionNotifiers({
  noteCompaction,
  send,
}: {
  noteCompaction: (event: CompactionEventName, facts: CompactionFacts) => void;
  send: (event: string, data: unknown) => void;
}) {
  return {
    preCompactNotify: async (input: HookInput): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreCompact") return { continue: true };
      // Opens a compaction (records nothing yet — nothing has been compacted).
      noteCompaction("compacting", {
        at: Date.now(),
        trigger: input.trigger === "auto" ? "auto" : "manual",
      });
      send("compacting", { trigger: input.trigger });
      return { continue: true };
    },
    postCompactNotify: async (input: HookInput): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PostCompact") return { continue: true };
      // Records what this hook knows — the trigger, and that it FINISHED.
      // `compact_boundary` carries the counts and merges into the same record
      // whichever of the two arrives first (foldCompactionEvent takes no
      // position on an ordering this codebase has never traced). The summary
      // text is not recorded on purpose: a marker states, it does not narrate.
      noteCompaction("compacted", {
        at: Date.now(),
        trigger: input.trigger === "auto" ? "auto" : "manual",
      });
      send("compacted", { trigger: input.trigger, summary: input.compact_summary });
      return { continue: true };
    },
  };
}
