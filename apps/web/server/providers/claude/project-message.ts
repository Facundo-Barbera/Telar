// THE CLAUDE MESSAGE PROJECTOR — SDKMessage in, renderable events out.
//
// This is the first resident of apps/web/server/, the layer that owns session
// mechanics with no HTTP in sight (docs/t3code-convergence-plan.md; the t3code
// analogue is the SDKMessage→event mapping inside ClaudeAdapter). The function
// below IS the loop body that lived inline in app/api/chat/route.ts:2160-2580
// since the route's birth, extracted verbatim so that:
//
//   1. It can run OUTSIDE a POST. The persistent session runtime (#28,
//      lib/server/session-runtime.ts) receives messages after the turn's HTTP
//      response is gone — a background agent's output between turns has to be
//      projected by something that doesn't need an SSE controller in scope.
//   2. It can be TESTED. The route has no test file; this, its riskiest 400
//      lines, now has one (project-message.test.ts).
//
// PURITY CONTRACT. projectClaudeMessage touches nothing but its arguments —
// no I/O, no globals; the single clock read is compact_boundary's `at` stamp,
// carried over from the inline code. Everything stateful lives in ClaudeTurnState,
// owned by the caller for exactly one turn. The two side effects the old loop
// interleaved here stay with the CALLER, signalled via the projection result:
// the compact_boundary fold (`compaction`) and the getContextUsage control
// call (`mainAssistantStep`) — the latter must be awaited between messages
// while the query is still bidirectional, which only the consuming loop can do.
//
// system:init is DELIBERATELY not handled here. Init is turn bookkeeping
// (session adoption, log opening, stub persistence), not projection — the
// caller handles it before consulting this function.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CompactionFacts } from "@/lib/compaction";
import { autoDenialMessage } from "@/lib/permission-denial";
import { isCancelledToolResult } from "@/lib/tool-cancellation";
import type { Part } from "@/lib/store";
import {
  agentMetaFromInput,
  AGENT_SPAWN_TOOL_CANDIDATES,
  capToolInput,
  capToolOutput,
  extractToolResultText,
  ParentFlattener,
} from "@/lib/transcript";

// Hard ceiling on how many tool calls a single turn persists with full
// input/output detail (rationed PER PARENT — see rationToolDetail). Moved with
// the loop from route.ts; capToolInput/capToolOutput bound each part's own
// size, this bounds the COUNT so one pathological turn can't blow up
// chats.json or the blocking write it forces on every other chat.
export const MAX_DETAILED_TOOL_PARTS = 200;

/** One renderable event, exactly as the route's send() emits it over SSE and
 *  mirrors it into the session log — same names, same payloads. */
export type ProjectedEvent = { event: string; data: unknown };

export type TurnResult = {
  subtype: string;
  totalCostUsd: number;
  turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

/** Everything one turn's projection accumulates. Owned by the consuming loop;
 *  `parts` is what appendTurn persists at teardown. */
export type ClaudeTurnState = {
  parts: Part[];
  /** parts[i]'s originating SDKMessage uuid, index-aligned with `parts` —
   *  scratch bookkeeping so a refusal-fallback `supersedes` list can evict the
   *  exact entries it retracts (see the assistant branch). */
  partOrigin: (string | undefined)[];
  /** Text accumulated from deltas for the current content block, keyed by
   *  resolved parent id (null = main conversation). A Map, not a single
   *  string: with forwardSubagentText the main turn and any number of
   *  concurrently-streaming subagents interleave their stream_event deltas on
   *  this one loop — a shared scalar would let them clobber each other. */
  streamingText: Map<string | null, string>;
  /** Flattens subagent-of-a-subagent nesting to the top-level spawn's
   *  tool_use id — see lib/transcript.ts's ParentFlattener. */
  parentFlatten: ParentFlattener;
  /** The final MAIN-THREAD assistant call's usage — the basis for CTX.
   *  Distinct from lastResult.usage, which is a step SUM across the turn. */
  lastMainUsage: Record<string, number> | null;
  /** The last "result" message's totals. Captured, never acted on per-message:
   *  a backgrounded subagent can wake an SDK auto-continuation that produces a
   *  second "result" in the same stream, and these are running totals for the
   *  whole query() invocation — acting on every one would double-count. */
  lastResult: TurnResult | null;
  costUsd: number;
  /** EVERY task completion this state observed, keyed by the spawn's
   *  tool_use id — including completions for spawns from an EARLIER turn,
   *  whose parts are not in `parts` at all (a mid-window second turn starts a
   *  fresh state while the previous turn's agents are still finishing). The
   *  caller pushes this whole map through the store's write-through at
   *  teardown and settle; without it, a cross-turn completion mutated
   *  nothing, persisted nowhere, and the agent shimmered "running" forever. */
  taskStatuses: Map<string, "completed" | "failed" | "stopped">;
};

export function newClaudeTurnState(): ClaudeTurnState {
  return {
    parts: [],
    partOrigin: [],
    streamingText: new Map(),
    parentFlatten: new ParentFlattener(),
    lastMainUsage: null,
    lastResult: null,
    costUsd: 0,
    taskStatuses: new Map(),
  };
}

export type ClaudeProjection = {
  events: ProjectedEvent[];
  /** Set for a compact_boundary message: the caller folds this into its
   *  compaction record (issue #25) — the event itself is already in `events`. */
  compaction?: CompactionFacts;
  /** True when this was a MAIN-THREAD assistant step: the caller should now
   *  await its getContextUsage() control call, while the query is still
   *  bidirectional (the SDK closes stdin once the final result frame lands). */
  mainAssistantStep?: boolean;
};

const NO_EVENTS: ClaudeProjection = { events: [] };

// Structural shapes for the wire fields each branch reads — the SDK's own
// types are wider unions than these branches consume, and the old inline code
// used `Record<string, any>` casts; `unknown`-based shapes keep the same
// tolerance without the `any`s (lint ceiling).
type StreamEventShape = {
  type?: string;
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; thinking?: string };
};
type ContentBlockShape = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export function projectClaudeMessage(
  msg: SDKMessage,
  state: ClaudeTurnState,
): ClaudeProjection {
  const { parts, partOrigin, streamingText, parentFlatten } = state;
  const events: ProjectedEvent[] = [];
  const send = (event: string, data: unknown) => events.push({ event, data });

  if (msg.type === "stream_event") {
    const parent = parentFlatten.resolve(
      (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
    );
    const ev = (msg as unknown as { event?: StreamEventShape }).event;
    if (ev?.type === "content_block_start") {
      if (ev.content_block?.type === "thinking") {
        send("thinking", parent ? { parent } : {});
      }
      streamingText.set(parent, "");
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      const text = ev.delta.text ?? "";
      streamingText.set(parent, (streamingText.get(parent) ?? "") + text);
      send("delta", { text, ...(parent ? { parent } : {}) });
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
      // Interleaved narration text, not persisted (no "thinking" Part variant):
      // live-only, same treatment as permission cards. "thinking" above already
      // told the client a block started; this streams its growing text.
      send("thinking_delta", {
        text: ev.delta.thinking ?? "",
        ...(parent ? { parent } : {}),
      });
    }
    return { events };
  }

  if (msg.type === "assistant") {
    // A non-null parent_tool_use_id means this message came from a subagent's
    // own internal conversation, relayed on this same top-level stream because
    // forwardSubagentText is on. Still appended to the same flat `parts` array
    // — attributed via parentId — so the client can render it as its own tab.
    const parent = parentFlatten.resolve(
      (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
    );
    const msgUuid = (msg as { uuid?: string }).uuid;
    // Context-window occupancy = the FINAL main-thread model call's prompt.
    // Each assistant message carries its own single-call usage; the result
    // message's usage is the SUM across every step (13 tool steps → ~13× the
    // real window). Capture the last main-thread call so CTX is the real thing.
    if (!parent) {
      const mu = (msg as unknown as { message?: { usage?: Record<string, number> } })
        .message?.usage;
      if (mu) state.lastMainUsage = mu;
    }
    const content =
      (msg as unknown as { message?: { content?: ContentBlockShape[] } }).message?.content ?? [];
    for (const block of content) {
      if (block.type === "text") {
        const text = block.text ?? "";
        parts.push({
          type: "text",
          text,
          ...(parent ? { parentId: parent } : {}),
        });
        partOrigin.push(msgUuid);
        send("text", { text, ...(parent ? { parent } : {}) }); // finalize the streamed block
        streamingText.set(parent, "");
      }
      if (block.type === "tool_use") {
        const id = block.id as string;
        const name = block.name as string;
        const rawInput = (block.input ?? {}) as Record<string, unknown>;
        const input = capToolInput(rawInput);
        const part: Extract<Part, { type: "tool" }> = {
          type: "tool",
          id,
          name,
          input,
          ...(parent ? { parentId: parent } : {}),
        };
        // This tool_use IS a spawn step: enrich its part with agent meta and
        // record it in parentFlatten so messages the spawned subagent forwards
        // under this id resolve straight to it — including a subagent that
        // itself spawns a sub-subagent, flattened to this same top-level id.
        //
        // Matched against the candidate LIST, not a single name detected from
        // init.tools: live testing showed init advertises the spawn tool under
        // its legacy registered name ("Task") while actual tool_use blocks
        // carry the SDK's current canonical name ("Agent") — the two disagree
        // within the same session, so a single detected name never matches.
        if ((AGENT_SPAWN_TOOL_CANDIDATES as readonly string[]).includes(name)) {
          part.agent = agentMetaFromInput(rawInput);
          parentFlatten.noteSpawn(id, parent);
        }
        parts.push(part);
        partOrigin.push(msgUuid);
        send("tool", {
          id,
          name,
          input,
          ...(part.agent ? { agent: part.agent } : {}),
          ...(parent ? { parent } : {}),
        });
      }
    }
    // Refusal-fallback retry: the SDK retried on a fallback model and this
    // message's `supersedes` names the wire uuids of previously-delivered
    // frames it replaces. Evict whatever this turn already queued from those
    // frames so a retracted tool call never persists as final output.
    const supersedes = (msg as { supersedes?: string[] }).supersedes;
    if (supersedes?.length) {
      const dead = new Set(supersedes);
      for (let i = parts.length - 1; i >= 0; i--) {
        const origin = partOrigin[i];
        if (origin && dead.has(origin)) {
          parts.splice(i, 1);
          partOrigin.splice(i, 1);
        }
      }
    }
    return { events, mainAssistantStep: !parent };
  }

  if (msg.type === "user") {
    // Tool results: the SDK relays the model's `user` turn carrying
    // tool_result blocks — this turn's own and any forwarded subagent's.
    // Attach output/isError onto the matching "tool" part (by tool_use_id,
    // globally unique regardless of nesting depth) so persistence includes
    // results, and mirror the same data as an event. A tool_result whose id
    // matches no part is stray side-channel noise — skip it.
    const parent = parentFlatten.resolve(
      (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id,
    );
    const content =
      (msg as unknown as { message?: { content?: ContentBlockShape[] } }).message?.content ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const id = block.tool_use_id as string;
      const part = parts.find(
        (p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.id === id,
      );
      if (!part) continue;
      // A duplicate/retried delivery for the same tool_use_id: first write
      // wins rather than silently overwriting an already-resolved result.
      if (part.output !== undefined) continue;
      const output = capToolOutput(extractToolResultText(block.content));
      const isError = !!block.is_error;
      // #28: a call the CLI filled in after an interrupt is NOT a refusal, and
      // telar rendered the two identically. Flagged here, where the result is
      // first seen, so the surface and the persisted transcript agree.
      const cancelled = isCancelledToolResult(output);
      part.output = output;
      part.isError = isError;
      if (cancelled) part.cancelled = true;
      send("tool_result", {
        id,
        output,
        isError,
        ...(cancelled ? { cancelled: true } : {}),
        ...(parent ? { parent } : {}),
      });
    }
    return { events };
  }

  if (msg.type === "system" && msg.subtype === "task_notification") {
    // Authoritative completion signal for a backgrounded subagent. The spawn
    // tool_use's own tool_result ("Async agent launched successfully…") lands
    // almost immediately and is NOT the subagent's real completion — this
    // system message, keyed by the spawn's own tool_use id (a control-plane
    // notification ABOUT a tool_use, not a forwarded message FROM one), is.
    const tn = msg as { tool_use_id?: string; status?: "completed" | "failed" | "stopped" };
    if (tn.tool_use_id && tn.status) {
      state.taskStatuses.set(tn.tool_use_id, tn.status);
      const part = parts.find(
        (p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.id === tn.tool_use_id,
      );
      if (part) part.taskStatus = tn.status;
      // Emitted whether or not a part matched: a mid-window second turn's
      // state has no parts for the PREVIOUS turn's spawns, but the client
      // still holds those spawns and updates them by id — swallowing the
      // event here left their tabs "running" forever.
      send("task_status", { id: tn.tool_use_id, status: tn.status });
    }
    return { events };
  }

  if (msg.type === "system" && msg.subtype === "permission_denied") {
    // Auto-denied without an interactive prompt — the model's normal
    // tool_use/tool_result exchange still happens (handled by the branches
    // above), so in the common case this adds WHY onto the existing tool part.
    // The fallback covers the rare ordering where this message is seen before
    // that tool_use block ever is.
    const pd = msg as unknown as {
      tool_name: string;
      tool_use_id: string;
      message: string;
      decision_reason_type?: string;
      decision_reason?: string;
      agent_id?: string;
    };
    // The message the MODEL is given, which is not the message the SDK
    // supplied — see lib/permission-denial.ts. The SDK's default text asserts
    // the user refused; for a classifier or working-directory block nobody was
    // asked, and a sub-agent told to "wait for the user" waits forever.
    const denialMessage = autoDenialMessage(
      pd.decision_reason_type,
      pd.decision_reason,
      pd.message,
    );
    send("permission_denied", {
      toolName: pd.tool_name,
      toolUseId: pd.tool_use_id,
      message: denialMessage,
      reason: pd.decision_reason_type,
      // Forwarded for the surface, NOT for the model: the operator needs the
      // raw discriminator and the originating agent to tell an auto-block
      // apart from their own refusal at a glance.
      reasonDetail: pd.decision_reason,
      agentId: pd.agent_id,
      sdkMessage: pd.message,
    });
    const existing = parts.find(
      (p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.id === pd.tool_use_id,
    );
    if (existing) {
      existing.autoDenied = true;
      existing.isError = true;
      if (existing.output === undefined) existing.output = denialMessage;
    } else {
      parts.push({
        type: "tool",
        id: pd.tool_use_id,
        name: pd.tool_name,
        isError: true,
        autoDenied: true,
        output: denialMessage,
      });
      partOrigin.push(undefined);
    }
    return { events };
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    // The SDK's own record that it rewrote this session's history down to a
    // summary — `manual` and `auto` alike. The PreCompact/PostCompact hooks
    // already sent "compacting"/"compacted"; this message carries the
    // token-count metadata neither hook receives, so it is its own event
    // rather than folded into either hook's send().
    const cb = msg as unknown as {
      compact_metadata?: {
        trigger?: "manual" | "auto";
        pre_tokens?: number;
        post_tokens?: number;
        duration_ms?: number;
      };
    };
    const boundary: CompactionFacts = {
      at: Date.now(),
      trigger: cb.compact_metadata?.trigger === "auto" ? "auto" : "manual",
      preTokens: cb.compact_metadata?.pre_tokens,
      postTokens: cb.compact_metadata?.post_tokens,
      durationMs: cb.compact_metadata?.duration_ms,
    };
    send("compact_boundary", boundary);
    return { events, compaction: boundary };
  }

  if (msg.type === "result") {
    // Capture only — the caller acts on lastResult exactly once, after its
    // loop ends, so only the final (most complete) totals are ever persisted
    // or broadcast (see the field's own comment on ClaudeTurnState).
    const r = msg as unknown as {
      subtype: string;
      total_cost_usd?: number;
      num_turns?: number;
      usage?: TurnResult["usage"];
    };
    state.costUsd = r.total_cost_usd ?? 0;
    state.lastResult = {
      subtype: r.subtype,
      totalCostUsd: state.costUsd,
      turns: r.num_turns,
      usage: r.usage,
    };
    return NO_EVENTS;
  }

  return NO_EVENTS;
}

// ── Teardown finalizers ─────────────────────────────────────────────────────
// Pure functions over ClaudeTurnState, called from the consuming loop's
// finally in this order: flush → markInterrupted → rationToolDetail.

/** Flush every parent's in-progress (never text-block-finalized) streamed text
 *  — the main turn's (key null) and any forwarded subagent's alike — so an
 *  abort/crash mid-stream doesn't drop what was already visible to the user. */
export function flushStreamingText(state: ClaudeTurnState): void {
  for (const [parent, text] of state.streamingText) {
    if (text) {
      state.parts.push({ type: "text", text, ...(parent ? { parentId: parent } : {}) });
    }
  }
}

/** A tool part still missing output never got a matching tool_result — the
 *  turn was aborted or crashed mid-flight (a graceful "result" only arrives
 *  once every tool call has resolved, denials included). Flag it so the client
 *  renders "interrupted" rather than identically to an empty success. Returns
 *  whether anything was flagged, so the caller can broadcast "interrupted". */
export function markInterruptedTools(state: ClaudeTurnState): boolean {
  let anyInterrupted = false;
  for (const part of state.parts) {
    if (part.type === "tool" && part.output === undefined) {
      part.interrupted = true;
      anyInterrupted = true;
    }
  }
  return anyInterrupted;
}

/** Bound how many tool parts keep full input/output detail — rationed PER
 *  PARENT (main thread = undefined, each subagent spawn = its own tool_use
 *  id), not with one shared counter: forwardSubagentText means one chatty
 *  subagent's tool calls share the flat array with the main thread's own, and
 *  a shared counter would let its noise strip detail from the main thread's
 *  calls, which is what a user actually asked for most. */
export function rationToolDetail(
  state: ClaudeTurnState,
  max: number = MAX_DETAILED_TOOL_PARTS,
): void {
  const detailedByParent = new Map<string | undefined, number>();
  for (const part of state.parts) {
    if (part.type !== "tool") continue;
    const count = (detailedByParent.get(part.parentId) ?? 0) + 1;
    detailedByParent.set(part.parentId, count);
    if (count > max) {
      delete part.input;
      delete part.output;
    }
  }
}
