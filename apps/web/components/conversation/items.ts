// THE TRANSCRIPT ITEM MODEL — the shell's input, carved out of session-view.tsx.
//
// WHY THIS FILE EXISTS. The 2026-07-23 UX session found the same chat surface
// hand-rebuilt in SIX lanes. Epic 3's deliverable is that it stops at six: one
// Conversation shell, fed a list of typed items, each rendered by a registered
// kind. Everything here is the DATA half of that contract — the part that must
// be a pure function so it can be proven without a DOM harness (there is none in
// this repo, deliberately; see §6.2 of story 3.1).
//
// TWO LEVELS, NOT ONE. `Part` is what the SSE stream and the store speak.
// `RenderItem` is `groupParts`' projection of a message's parts into rendered
// chunks (a run of consecutive tool calls collapses into one group). Neither of
// those is the shell's vocabulary: the shell speaks `TranscriptItem`, an open
// envelope of `{ kind, key, payload }` whose `kind` is resolved through the
// item-kind registry. `toTranscriptItems` is the one bridge between the closed
// union and the open envelope — widening it, not replacing it.
//
// NO "use client" HERE, ON PURPOSE. This module is pure data + pure functions,
// so it is usable from a server component and — more importantly — INV-4's BFS
// does not treat it as a client root. Anything needing the directive belongs in
// conversation.tsx or kinds.tsx.
//
// NOTHING HERE IMPORTS @telar/core AT RUNTIME (AD-3, and INV-4c enforces it).

import type { ReactNode } from "react";
import type { AgentTab } from "@/components/session/agent-tabs";
import type { AgentInfo, ToolPart } from "@/components/session/tool-step";
import type { WorkState } from "@/components/session/working-indicator";
import type { ItemKindId } from "./registry";

// ── the wire + store shapes, moved verbatim from session-view.tsx ───────────

// The transcript shape the store persists (see lib/store.ts). Text parts stream
// with a `done` flag on the client; persisted parts are always finished. Tool
// parts carry id/input/output/isError as optional so every old persisted chat
// (name-only tool parts) still loads without a migration. `parentId`/`agent`
// are newer still and equally optional for the same reason: an old chat's
// parts simply lack them, which reads as "main thread, not a spawn" — exactly
// the right default.
export type StorePart =
  | { type: "text"; text: string; parentId?: string }
  | {
      type: "tool";
      name: string;
      id?: string;
      input?: Record<string, unknown>;
      output?: string;
      isError?: boolean;
      interrupted?: boolean;
      parentId?: string;
      agent?: AgentInfo;
      taskStatus?: "completed" | "failed" | "stopped";
      // Set when auto/acceptEdits mode hard-blocked this call without an
      // interactive prompt (route.ts's "permission_denied" handling).
      autoDenied?: boolean;
    }
  // What the user attached to a message. METADATA ONLY, and that is the whole
  // design: the bytes live under the Telar state root with a lifetime of their
  // own (destroyed when the chat is archived — see apps/web/lib/attachments.ts),
  // while this part is persisted in the transcript and outlives them. When the
  // bytes are gone the chip renders as a TOMBSTONE, which is possible precisely
  // because every field needed to draw one is here rather than fetched.
  | { type: "attachments"; files: AttachmentRef[] };

/** One attachment, as the transcript remembers it. `id` addresses the bytes
 *  through /api/chat/attachments/<id> for as long as they exist. */
export type AttachmentRef = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
};

export type StoreMessage = { role: "user" | "assistant"; parts: StorePart[] };

// Permission cards are live-stream-only artifacts (resolved by "permission_result"
// or the server's 120s timeout deny) — they never round-trip through the store,
// so StorePart above stays exactly as persisted. They also never carry a
// parentId: canUseTool gets no parent attribution from the SDK, so every
// permission card — regardless of which subagent's tool call triggered it —
// renders on the Main thread (a documented v1 limitation, not a bug).
//
// "thinking" parts are the same kind of live-only artifact: the server emits
// "thinking"/"thinking_delta" purely as SSE (see route.ts's stream_event
// handling), never persisting narration text into a store Part, so there's
// nothing to seed on reload — a thinking block only ever exists while its
// turn is actually streaming.
export type Part =
  | { type: "text"; text: string; done: boolean; parentId?: string }
  | { type: "thinking"; text: string; done: boolean; parentId?: string }
  | ToolPart
  // Identical to its StorePart twin: an attachment part is complete the moment
  // it exists (nothing about it streams), so unlike text it needs no `done`.
  | { type: "attachments"; files: AttachmentRef[] }
  | {
      type: "permission";
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      rule: string;
      // Narrow -> broad rule choices offered for this call (ruleOptionsFor,
      // server-side) — the user, not a heuristic, picks how wide an "Always
      // allow" persists. `rule` above is always one of these (the default,
      // prefix, option).
      ruleOptions: Array<{ rule: string; label: string }>;
      status: "pending" | "allowed" | "denied";
    };
export type ChatMessage = { id: string; role: "user" | "assistant"; parts: Part[] };

// Exported: apps/web/lib/gallery-fixtures (kept dev design-review surface) uses
// this shape directly, THROUGH session-view.tsx's re-export of this same type.
// Type-only export, zero logic change.
export type PermissionPart = Extract<Part, { type: "permission" }>;

// A part's parentId, normalized to `undefined` for the main thread (permission
// parts don't have the field at all — they're always main). Centralizing this
// lookup means every routing decision (grouping, streaming merge, bucketing)
// agrees on what "main thread" means.
export const parentOf = (p: Part): string | undefined =>
  // Attachments join permission cards as a MAIN-THREAD-ONLY part: a subagent
  // has no composer, so nothing can attach a file from inside a spawn. Naming
  // both here rather than giving the variant an unused `parentId` field keeps
  // "can this be parented" a fact about the union instead of a field nobody sets.
  p.type === "permission" || p.type === "attachments" ? undefined : p.parentId;

// One spawned subagent's own transcript, reconstructed identically whether
// it's arriving live (SSE events tagged with `parent`) or reconstructed from
// persisted parts (tagged with `parentId`) — see agentBuckets in the adapter.
// `spawn` is the enriched tool part itself (id, agent info, and — once the
// subagent finishes — its output/isError), `parts` is everything that part
// spawned.
export type AgentBucket = { id: string; spawn: ToolPart; parts: Part[] };

// Label priority per spec: an explicit run name, else a clipped slice of the
// free-form description, else the agent type, else a generic fallback. The
// description comes before the type because the type is shared across every
// spawn of the same subagent — several concurrent "general-purpose" spawns
// would otherwise all render the identical, useless tab label — while the
// description is supplied fresh per spawn and is what actually distinguishes
// them. Array.from/codePoints mirrors stepPreview's astral-safe slicing.
export function agentLabel(agent: AgentInfo): string {
  if (agent.name) return agent.name;
  const description = agent.description.trim();
  if (description) {
    const codePoints = Array.from(description);
    return codePoints.length > 24 ? `${codePoints.slice(0, 24).join("")}…` : codePoints.join("");
  }
  if (agent.type) return agent.type;
  return "subagent";
}

export function agentStatus(spawn: ToolPart): AgentTab["status"] {
  // taskStatus (from the SDK's task_notification, route.ts) is the
  // authoritative completion signal for a backgrounded subagent and takes
  // priority when present. Subagents run in the background by default, so
  // spawn.output/isError below reflect only the near-instant "launched" ack
  // — NOT the subagent's real result — and would otherwise flip this tab to
  // "done" while the subagent is still actually working. Absent taskStatus
  // (a synchronous subagent, or an SDK build that never sends it) falls
  // through to the old output-based read.
  if (spawn.taskStatus) {
    return spawn.taskStatus === "completed" ? "done" : "error";
  }
  if (spawn.output === undefined) {
    // A spawn that never got its tool_result because the whole turn ended
    // abnormally (Stop clicked, mid-turn error, dropped connection — see
    // route.ts's teardown) is not "still running": the turn is over, and
    // `running`'s shimmer would otherwise animate forever for a dead tab.
    // AgentTab's status vocabulary is only three states (spec), so this
    // folds into the destructive tint rather than adding a fourth.
    return spawn.interrupted ? "error" : "running";
  }
  // A background spawn's near-instant tool_result is only the launch ack
  // (isAsyncLaunchAck below) — the subagent is still working until its
  // task_notification sets taskStatus. Without this, every background spawn
  // reads "done" seconds after launch. `interrupted` keeps a Stopped turn's
  // acked-but-unfinished spawn out of the forever-shimmer case.
  if (isAsyncLaunchAck(spawn.output)) {
    return spawn.interrupted ? "error" : "running";
  }
  return spawn.isError ? "error" : "done";
}

// Newer Claude Code builds run subagents asynchronously: the spawn tool
// call's tool_result lands almost instantly and is just an internal launch
// acknowledgement ("Async agent launched successfully", plus bookkeeping —
// agentId/output_file/"Do NOT Read or tail" — meant for the orchestrating
// agent, not a human). It is NOT the subagent's real result. The subagent's
// actual output already streams into its own tab as ordinary assistant
// messages (bucket.parts), so rendering this ack text in the "Result" block
// would just leak Claude's internal plumbing into the UI. Matched on the
// literal launch phrase, or (in case wording drifts) the "internal
// metadata" + "agentId" combination that's specific to this ack and not
// something a genuine subagent result would ever contain together.
export function isAsyncLaunchAck(text: string): boolean {
  if (text.includes("Async agent launched successfully")) return true;
  return text.includes("internal metadata") && text.includes("agentId");
}

// ── the projection, moved verbatim ─────────────────────────────────────────

// One rendered chunk of an assistant message's parts: standalone text,
// standalone permission card (always interactive, so it always breaks a
// tool-step group), or a run of consecutive tool parts collapsed into one
// group. Keys are stable across re-renders — the group key doubles as the
// identity used to remember a user's manual expand/collapse override.
export type RenderItem =
  | { kind: "text"; key: string; part: Extract<Part, { type: "text" }> }
  | { kind: "thinking"; key: string; part: Extract<Part, { type: "thinking" }> }
  | { kind: "permission"; key: string; part: Extract<Part, { type: "permission" }> }
  | { kind: "attachments"; key: string; part: Extract<Part, { type: "attachments" }> }
  | { kind: "tools"; key: string; parts: ToolPart[] };

export function groupParts(messageId: string, parts: Part[]): RenderItem[] {
  const items: RenderItem[] = [];
  parts.forEach((part, idx) => {
    if (part.type === "tool") {
      const last = items[items.length - 1];
      if (last?.kind === "tools") {
        last.parts.push(part);
      } else {
        // A tool_use id is unique for the life of the id, but old persisted
        // parts predate the id field — fall back to a message-scoped index,
        // stable because parts only ever get appended to, never reordered.
        items.push({ kind: "tools", key: part.id ?? `${messageId}:${idx}`, parts: [part] });
      }
    } else if (part.type === "text") {
      items.push({ kind: "text", key: `${messageId}:${idx}`, part });
    } else if (part.type === "thinking") {
      // A THINKING BLOCK WITH NO TEXT IS NOT CONTENT, AND MUST NOT SEVER A RUN.
      // `thinkingSuppressed` already renders such a block as nothing; without
      // the same rule HERE, the grouping layer and the render layer disagree
      // about what is visible, and that disagreement is what a user sees.
      //
      // Concretely: the client opens a thinking part on the block-START event,
      // before any delta exists (session-view's "thinking" case). Interleaved
      // extended thinking opens one such block before EACH tool call, so a
      // turn's parts read `thinking(""), tool, thinking(""), tool, …` — and
      // because only CONSECUTIVE tool parts coalesce below, every empty block
      // split the run into its own group. Eight tool calls rendered as eight
      // identical "1 step · Ran command" rows separated by nothing at all,
      // because the thing separating them drew no pixels. Codex makes the same
      // shape permanent rather than transient: it emits block-start and then no
      // reasoning deltas ever (see thinkingSuppressed's own note).
      //
      // Skipping here rather than merging across it keeps the rule ONE rule:
      // a block that has text is a real boundary and still splits the run.
      if (thinkingSuppressed(part)) return;
      items.push({ kind: "thinking", key: `${messageId}:${idx}`, part });
    } else if (part.type === "attachments") {
      items.push({ kind: "attachments", key: `${messageId}:${idx}`, part });
    } else {
      items.push({ kind: "permission", key: `${messageId}:${idx}`, part });
    }
  });
  return items;
}

// ── the transcript envelope (AD-12) ────────────────────────────────────────

// The shell's whole vocabulary. `payload` is `unknown` at the envelope and
// typed at the kind: a renderer casts ONCE, at its own boundary. That is the
// same discipline RenderItem's discriminated union already had — this widens it
// from closed to open so epics 4/5/6 can register their own kinds without
// editing this file.
//
// `key` NAMES THE EVENT, NOT THE SLOT (the house maxim, paid for three times in
// story 1.1). It is derived from a tool_use id where one exists and falls back
// to `${messageId}:${idx}` ONLY because parts are append-only and never
// reordered. The day parts reorder, that fallback names the wrong slot.
export type TranscriptItem = { kind: ItemKindId; key: string; payload: unknown };

// The eight built-in ids. Namespaced (`conversation:*`) like every other kind,
// because AD-13 admits no unnamespaced ids and a bare `text` would be exactly
// the collision the rule exists to prevent. INV-8f pins this set exactly.
//
// `attachments` is the eighth and is a BUILT-IN rather than a registered kind
// because it is part of what a user message IS, in every surface that renders
// one — the same argument that makes `text` built-in. A surface-registered kind
// would leave the six lanes epic 3 exists to unify each re-solving "what does a
// dropped screenshot look like".
export const CONVERSATION_KINDS = {
  turn: "conversation:turn",
  text: "conversation:text",
  thinking: "conversation:thinking",
  tools: "conversation:tools",
  permission: "conversation:permission",
  marker: "conversation:marker",
  status: "conversation:status",
  attachments: "conversation:attachments",
} as const;

export type PermissionRespond = (
  id: string,
  behavior: "allow" | "deny",
  always: boolean,
  rule?: string,
) => void;

// The payload shapes, pinned because four tracks build registrations against
// them. Each is what its renderer in kinds.tsx casts to.
export type TurnPayload = {
  from: "user" | "assistant";
  items: readonly TranscriptItem[];
  /** Rendered inside the bubble when `items` is empty — the in-flight
   *  "Thinking…"/"Weaving…" affordance. Built by the adapter, which is the only
   *  party that knows about `busy`. */
  pending?: ReactNode;
};
export type TextPayload = { text: string };
export type AttachmentsPayload = { files: AttachmentRef[] };
export type ThinkingPayload = { text: string; done: boolean };
export type ToolsPayload = {
  parts: ToolPart[];
  agentSteps?: (id: string) => number;
  onSelectAgent?: (id: string) => void;
};
export type PermissionPayload = {
  part: PermissionPart;
  /** Absent on a read-only surface. The card then renders resolved-state only.
   *  THIS OPTIONALITY IS THE MECHANISM that makes one kind renderable on every
   *  surface — see AD-12's purity rule and story 6.6's TranscriptView. */
  onRespond?: PermissionRespond;
};
export type MarkerPayload = { text: string; attention?: boolean };
// Live-only, like thinking parts: the adapter appends one status item to the
// turn currently streaming and never persists it. `state` is the SAME WorkState
// the header heartbeat renders — one derivation, two surfaces.
export type StatusPayload = { state: WorkState };

// The 1.3 suppression rule: A THINKING BLOCK WITH NO TEXT RENDERS NOTHING,
// live or finished. A persisted turn has no thinking text (the server never
// persists it), so a whitespace-only finished block must render nothing — the
// empty "✻ Thought" collapsible after a reload this rule was first written for.
//
// THE LIVE EXEMPTION IS GONE, and its removal is the fix rather than the
// "simplification" the previous comment here warned against. It rested on one
// premise — that suppressing the window between "thinking opened" and the first
// delta leaves the turn with no in-flight affordance — and that premise has
// since stopped holding twice over:
//
//   · The live STATUS ROW is now that affordance (showsLiveStatus, below). It
//     counts data parts, not rendered ones, so a suppressed thinking block still
//     leaves partCount > 0 and the row still appears. The turn is never mute.
//   · The window is not a window on every provider. Codex emits the block-start
//     event and then no reasoning deltas at all, so `{text: "", done: false}` is
//     not a moment there, it is the whole turn — one permanently empty dashed
//     box per block start, stacking up as the turn goes on. Measured against a
//     live codex-personal session: two of them, side by side, under a status row
//     that was already saying "Thinking 18s".
//
// A block that never receives text has nothing to show. The header says the
// model is thinking; an empty bordered box next to it says only that a renderer
// ran.
export function thinkingSuppressed(part: ThinkingPayload): boolean {
  return !part.text.trim();
}

// ── the live step window ───────────────────────────────────────────────────

// HOW MANY STEPS OF A *LIVE* GROUP STAY ON SCREEN. One, because a live group is
// a status display and a status display has one current value; the steps behind
// it are history that has not finished being made yet.
//
// The old behaviour was the opposite: a live group defaulted fully OPEN, so a
// turn that ran twenty tool calls grew a twenty-row wall, pushed the composer
// off-screen, and then — the moment the turn ended and the group snapped shut —
// threw all of it away. The user paid full attention cost for rows they could
// not read at streaming speed and could not keep.
export const LIVE_STEP_WINDOW = 1;

/** A live group's parts split into what's shown and what's behind the "+N
 *  earlier steps" toggle. `expanded` ⇒ the user asked for all of it. Generic
 *  because the RULE is about counts, not about tool parts — which is also what
 *  lets it be tested without constructing any. */
export function liveStepWindow<T>(
  parts: readonly T[],
  expanded: boolean,
): { hidden: readonly T[]; visible: readonly T[] } {
  if (expanded || parts.length <= LIVE_STEP_WINDOW) return { hidden: [], visible: parts };
  return { hidden: parts.slice(0, -LIVE_STEP_WINDOW), visible: parts.slice(-LIVE_STEP_WINDOW) };
}

// WHETHER THE STREAMING TURN GETS ITS STATUS ROW — the whole live-only rule, in
// one predicate, because the four clauses are what make the row live-only and a
// four-clause conditional buried in a `.map` has no test surface at all. It is
// the ASSISTANT'S turn, it is the LAST message, real parts already exist (an
// empty turn keeps `pending`'s shimmer — the shell renders items OR pending,
// never both), and the owner still has live work. `hasLiveWork` false is the
// case this exists for: a finished turn, and every turn after a reload, has none.
export function showsLiveStatus(turn: {
  role: string;
  hasLiveWork: boolean;
  partCount: number;
  isLast: boolean;
}): boolean {
  return turn.role === "assistant" && turn.hasLiveWork && turn.partCount > 0 && turn.isLast;
}

// Owner-supplied behaviour reaches a renderer THROUGH THE PAYLOAD, never through
// ambient context (AC4, and the fix architecture review's finding A3 made to
// AD-12). The adapter closes over its own state and hands the closures down.
export type ItemPayloadHooks = {
  onRespond?: PermissionRespond;
  agentSteps?: (id: string) => number;
  onSelectAgent?: (id: string) => void;
};

/** One `RenderItem` as the built-in `conversation:*` `TranscriptItem` it maps to. */
export function toTranscriptItem(item: RenderItem, hooks: ItemPayloadHooks = {}): TranscriptItem {
  switch (item.kind) {
    case "text":
      return {
        kind: CONVERSATION_KINDS.text,
        key: item.key,
        payload: { text: item.part.text } satisfies TextPayload,
      };
    case "thinking":
      return {
        kind: CONVERSATION_KINDS.thinking,
        key: item.key,
        payload: { text: item.part.text, done: item.part.done } satisfies ThinkingPayload,
      };
    case "attachments":
      return {
        kind: CONVERSATION_KINDS.attachments,
        key: item.key,
        payload: { files: item.part.files } satisfies AttachmentsPayload,
      };
    case "permission":
      return {
        kind: CONVERSATION_KINDS.permission,
        key: item.key,
        payload: { part: item.part, onRespond: hooks.onRespond } satisfies PermissionPayload,
      };
    case "tools":
      return {
        kind: CONVERSATION_KINDS.tools,
        key: item.key,
        payload: {
          parts: item.parts,
          agentSteps: hooks.agentSteps,
          onSelectAgent: hooks.onSelectAgent,
        } satisfies ToolsPayload,
      };
  }
}

export const toTranscriptItems = (
  items: readonly RenderItem[],
  hooks: ItemPayloadHooks = {},
): TranscriptItem[] => items.map((i) => toTranscriptItem(i, hooks));

// THE DONOR'S `isTrailing`, kept as one exported function so the two composite
// renderers that need it (conversation:turn and the adapter's own agent-bucket
// kind) cannot drift apart — the seventh-copy hazard, in miniature.
//
// A pending/just-resolved permission card is not a new unit of finished work —
// it's the same blocked tool call waiting on the user, so a trailing run of
// permission items doesn't end a group's liveness. The live status row is the
// same class of non-work: it narrates the turn rather than adding to it, so it
// must not demote the real last item (a streaming tools group would collapse
// and lose its spinner the moment the status row appears after it).
export function isTrailingItem(items: readonly TranscriptItem[], index: number): boolean {
  return items
    .slice(index + 1)
    .every(
      (it) =>
        it.kind === CONVERSATION_KINDS.permission || it.kind === CONVERSATION_KINDS.status,
    );
}
