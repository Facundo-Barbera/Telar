"use client";

// THE SEVEN BUILT-IN ITEM KINDS, and the leaf renderings they wrap.
//
// WHY A RENDERER TAKES (payload, view) AND NOT PROPS. A registered kind is a
// PURE FUNCTION of its item's payload and the view state the shell hands it —
// it reads nothing from ambient context (AD-12, and the fix architecture
// review's finding A3 made to it). A React component would invite props, and
// props invite a provider; the moment one kind needs a context its adapter
// supplies, a transcript holding that kind and one other can render NEITHER
// outside that adapter — which is precisely how `TranscriptView`, a surface with
// no providers at all, would stop being able to render anything.
//
// So: every renderer below is declared at MODULE SCOPE, outside any component.
// That is not a style choice. Inside SessionViewInner, `useDockOptional()` and
// `usePromptInputController()` are in lexical scope and a renderer written there
// could reach them today with no error — the exact failure INV-8b exists to
// catch. Out here the temptation does not exist.
//
// The disclosure state a renderer needs arrives through `view.isOpen` /
// `view.setOpen`, an OPAQUE keyed map the shell owns and the renderer names keys
// in. The shell scopes those keys to the item, so no renderer can read or clobber
// another item's state, and the shell never learns what a "tool group" is.
//
// Everything here was LIFTED from session-view.tsx's two near-identical dispatch
// switches, so the rendering is the SAME rendering (story 3.1 §5.4-A). If you are
// tempted to improve one of these while you are in here: don't. That is what a
// later story is for.

import { BotIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { StatusDot } from "@/components/session/agent-tabs";
import { ToolStepRow, type AgentInfo, type ToolPart } from "@/components/session/tool-step";
import { WorkingIndicator } from "@/components/session/working-indicator";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./approval-card";
import {
  CONVERSATION_KINDS,
  agentLabel,
  agentStatus,
  isTrailingItem,
  thinkingSuppressed,
  type MarkerPayload,
  type PermissionPayload,
  type StatusPayload,
  type TextPayload,
  type ThinkingPayload,
  type ToolsPayload,
  type TurnPayload,
} from "./items";
import { Marker } from "./marker";
import type { ItemKind } from "./registry";

// ── the leaf renderings, moved from session-view.tsx ───────────────────────

// Best-effort salient preview of a tool call's input: the path/command a human
// actually cares about, or a capped JSON dump for anything else.
export function permissionPreview(input: Record<string, unknown>): string {
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

// Interleaved narration, rendered live-only (see the Part union comment in
// items.ts — there's no persisted counterpart). While the block is still
// streaming (`!part.done`) it's a growing muted italic block, matching the
// shimmer's "something is happening" register without competing with real answer
// text. Once the block ends it collapses to a single "✻ Thought" row, click to
// expand — same disclosure idiom as ToolStepRow, just without a chevron rotate
// on the live (never-collapsed) state. No fade-from-zero keyframes anywhere here
// (WebKit 26.x) — only a transform transition on the chevron, same as every
// other expand/collapse row in this file.
export function ThinkingRow({
  part,
  open,
  onToggle,
}: {
  part: ThinkingPayload;
  open: boolean;
  onToggle: () => void;
}) {
  // The suppression rule itself lives in items.ts, where a test can drive it —
  // the LIVE exemption is the whole behaviour change and is exactly the sort a
  // later "simplification" back to `!part.text.trim()` would silently revert.
  if (thinkingSuppressed(part)) return null;

  if (!part.done) {
    // Live stream: a growing muted italic block with a ✻ + shimmering "Thinking"
    // header and a blinking caret — the "something is happening" register.
    return (
      <div className="rounded-md border border-dashed bg-muted/10 px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-[11px] font-medium">
            Thinking
          </Shimmer>
        </div>
        <p className="text-xs italic leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {part.text}
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-muted-foreground/70 align-middle" />
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <span aria-hidden className="shrink-0">✻</span>
        <span className="min-w-0 flex-1 truncate italic">Thought</span>
        <ChevronRightIcon
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <p className="mx-1.5 mb-1.5 rounded-md bg-muted/10 p-2 text-[11px] whitespace-pre-wrap italic text-muted-foreground">
          {part.text}
        </p>
      )}
    </div>
  );
}

// A spawn step's row inside the main thread's B.3 groups — an "agent chip"
// rather than a generic tool row. Clicking it only switches the active tab
// (state, not focus/scroll): the raw input/output detail a normal tool row
// would expand inline lives in the subagent's own tab instead, so there's
// nothing to expand here.
export function AgentStepRow({
  part,
  stepCount,
  onSelect,
}: {
  part: ToolPart & { agent: AgentInfo };
  stepCount: number;
  onSelect: () => void;
}) {
  const status = agentStatus(part);
  const label = agentLabel(part.agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60",
        status === "error" && "bg-destructive/10",
      )}
    >
      <BotIcon
        className={cn("size-3.5 shrink-0", status === "error" ? "text-destructive" : "text-muted-foreground")}
      />
      {status === "running" ? (
        <Shimmer as="span" className="min-w-0 flex-1 truncate text-left text-xs">
          {label}
        </Shimmer>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate font-medium", status === "error" && "text-destructive")}>
          {label}
        </span>
      )}
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {stepCount} step{stepCount === 1 ? "" : "s"}
      </span>
      <StatusDot status={status} />
      <ChevronRightIcon className="ml-0.5 size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

// The group header: step count + compact tool tally, e.g.
// "16 steps · Bash ×12 · Read ×2 · Glob ×2" — order follows first appearance.
// `agentSteps`/`onSelectAgent` are only ever passed for main-thread groups —
// a subagent's own tab renders its nested tool calls with plain ToolStepRows,
// since v1 doesn't track sub-subagents (see AgentBucket).
export function ToolStepGroup({
  toolParts,
  open,
  onToggle,
  live,
  rowOpen,
  onToggleRow,
  agentSteps,
  onSelectAgent,
}: {
  toolParts: ToolPart[];
  open: boolean;
  onToggle: () => void;
  live: boolean;
  rowOpen: (key: string) => boolean;
  onToggleRow: (key: string) => void;
  agentSteps?: (id: string) => number;
  onSelectAgent?: (id: string) => void;
}) {
  const tally: Array<[string, number]> = [];
  const indexByName = new Map<string, number>();
  for (const p of toolParts) {
    const i = indexByName.get(p.name);
    if (i === undefined) {
      indexByName.set(p.name, tally.length);
      tally.push([p.name, 1]);
    } else {
      tally[i][1] += 1;
    }
  }
  // Surfaced even while collapsed — otherwise a group that just finished
  // showing a failing/cancelled step visually disappears the instant the
  // turn ends and the group auto-collapses back to its default.
  const hasError = toolParts.some((p) => p.isError);
  const hasInterrupted =
    !hasError && toolParts.some((p) => p.interrupted && p.output === undefined);

  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border bg-muted/20 text-xs",
        // Collapsed groups hug their label (a short "1 step · Bash ×1" in a
        // full-width bar reads as empty/heavy); only expand to full width when
        // open, so the rows inside have room.
        open ? "w-full" : "w-fit",
        hasError && "border-destructive/40",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {(hasError || hasInterrupted) && (
          <TriangleAlertIcon
            className={cn(
              "size-3 shrink-0",
              hasError ? "text-destructive" : "text-muted-foreground",
            )}
          />
        )}
        <span className={cn("shrink-0", hasError ? "text-destructive" : "text-muted-foreground")}>
          {toolParts.length} step{toolParts.length === 1 ? "" : "s"}
        </span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">
          {tally.map(([name, count]) => `${name} ×${count}`).join(" · ")}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
          {toolParts.map((p, i) => {
            const rowKey = p.id ?? String(i);
            if (p.agent && p.id && onSelectAgent) {
              return (
                <AgentStepRow
                  key={rowKey}
                  part={p as ToolPart & { agent: AgentInfo }}
                  stepCount={agentSteps?.(p.id) ?? 0}
                  onSelect={() => onSelectAgent(p.id!)}
                />
              );
            }
            return (
              <ToolStepRow
                key={rowKey}
                part={p}
                running={live && p.output === undefined && !p.isError}
                open={rowOpen(rowKey)}
                onToggle={() => onToggleRow(rowKey)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── the seven kinds ─────────────────────────────────────────────────────────

// THE COMPOSITE. The donor's transcript is two levels, not one, and BOTH carry
// visible styling: ConversationContent's `gap-8` spaces turns apart, Message's
// `gap-2` spaces items within a turn, and MessageContent branches on the
// ancestor's `is-user` class for the user bubble's background. A flat loop that
// rendered leaves as siblings would lose all three, and with no DOM harness in
// this repo nothing would catch it until a human opened the dev server.
//
// Making the turn a KIND rather than hard-wiring it into the shell buys three
// things: per-item liveness stays computable (the shell marks only the last
// top-level item live — the donor's `isCurrentMessage` — and this renderer
// derives `isTrailing` over its OWN children, exactly as the donor's loop does);
// the empty-turn shimmer gets a home in the payload, built by the only party
// that knows about `busy`; and a transcript with NO turns at all still works,
// which is what the subagent bucket and story 6.6's TranscriptView both need.
const turnKind: ItemKind<TurnPayload> = {
  id: CONVERSATION_KINDS.turn,
  render: (payload, view) => (
    <Message from={payload.from}>
      <MessageContent>
        {payload.items.length === 0
          ? payload.pending
          : payload.items.map((child, i) =>
              view.render(child, { live: view.live && isTrailingItem(payload.items, i) }),
            )}
      </MessageContent>
    </Message>
  ),
};

const textKind: ItemKind<TextPayload> = {
  id: CONVERSATION_KINDS.text,
  render: (payload) => <MessageResponse>{payload.text}</MessageResponse>,
};

const thinkingKind: ItemKind<ThinkingPayload> = {
  id: CONVERSATION_KINDS.thinking,
  render: (payload, view) => (
    <ThinkingRow
      part={payload}
      open={view.isOpen("open")}
      onToggle={() => view.setOpen("open", !view.isOpen("open"))}
    />
  ),
};

const toolsKind: ItemKind<ToolsPayload> = {
  id: CONVERSATION_KINDS.tools,
  // The trailing tool-step group of the message currently being streamed into
  // defaults OPEN; every other group defaults collapsed. A manual toggle always
  // wins over that default, which is why `isOpen` takes the default as its
  // fallback rather than the renderer pre-resolving it.
  render: (payload, view) => (
    <ToolStepGroup
      toolParts={payload.parts}
      open={view.isOpen("group", view.live)}
      live={view.live}
      onToggle={() => view.setOpen("group", !view.isOpen("group", view.live))}
      rowOpen={(key) => view.isOpen(`row:${key}`)}
      onToggleRow={(key) => view.setOpen(`row:${key}`, !view.isOpen(`row:${key}`))}
      agentSteps={payload.agentSteps}
      onSelectAgent={payload.onSelectAgent}
    />
  ),
};

const permissionKind: ItemKind<PermissionPayload> = {
  id: CONVERSATION_KINDS.permission,
  render: (payload) => {
    const { part, onRespond } = payload;
    return (
      <ApprovalCard
        title={part.toolName}
        preview={permissionPreview(part.input)}
        rule={part.rule}
        ruleOptions={part.ruleOptions}
        status={part.status}
        onRespond={
          onRespond
            ? (behavior, always, rule) => onRespond(part.id, behavior, always, rule)
            : undefined
        }
      />
    );
  },
};

// Ships with no production PRODUCER, and that is correct rather than
// speculative: it has two consumers on day one — the gallery lane, and the
// shell's own tombstone for an unregistered kind — and it is the shape Track F's
// `loom:*` markers will copy. "Born on it rather than migrated to it" is the
// whole point of epic 3.
const markerKind: ItemKind<MarkerPayload> = {
  id: CONVERSATION_KINDS.marker,
  render: (payload) => <Marker attention={payload.attention}>{payload.text}</Marker>,
};

// The persistent in-flight row. The turn's other liveness signals each cover a
// narrow window (empty-turn shimmer dies at the first part; the thinking block
// needs thinking enabled; a tool spinner dies at its tool_result) and the gaps
// between them are pixel-identical to a finished turn. This row is appended by
// the adapter to the streaming turn only, bound to the same WorkState the
// header heartbeat derives, so an in-flight turn always shows motion at its
// tail — including on embedded surfaces, which have no header bar at all.
const statusKind: ItemKind<StatusPayload> = {
  id: CONVERSATION_KINDS.status,
  render: (payload) => <WorkingIndicator state={payload.state} className="w-fit" />,
};

/** The seven built-ins, ready to spread into an owner adapter's own registry. */
export const BUILTIN_KINDS: readonly ItemKind<never>[] = [
  turnKind,
  textKind,
  thinkingKind,
  toolsKind,
  permissionKind,
  markerKind,
  statusKind,
] as unknown as readonly ItemKind<never>[];
