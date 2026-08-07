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

import { BotIcon, ChevronRightIcon, PaperclipIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { StatusDot } from "@/components/session/agent-tabs";
import {
  ToolStepRow,
  toolTallyLabel,
  type AgentInfo,
  type ToolPart,
} from "@/components/session/tool-step";
import { WorkingIndicator } from "@/components/session/working-indicator";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./approval-card";
import { attachmentUrl } from "@/lib/attachment-contract";
import {
  CONVERSATION_KINDS,
  LIVE_STEP_WINDOW,
  agentLabel,
  agentStatus,
  foldSettledTurn,
  isTrailingItem,
  liveStepWindow,
  thinkingSuppressed,
  type SettledTurnFold,
  type AttachmentRef,
  type AttachmentsPayload,
  type MarkerPayload,
  type PermissionPayload,
  type StatusPayload,
  type TextPayload,
  type ThinkingPayload,
  type ToolsPayload,
  type TranscriptItem,
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
      <div className="py-1 text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5">
          <span aria-hidden className="text-xs">
            ✻
          </span>
          <Shimmer as="span" className="text-[11px] font-medium">
            Thinking
          </Shimmer>
        </div>
        <p className="ml-5 border-l border-border/70 pl-3 text-xs italic leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
  insideFold,
  rowOpen,
  onToggleRow,
  agentSteps,
  onSelectAgent,
}: {
  toolParts: ToolPart[];
  open: boolean;
  onToggle: () => void;
  live: boolean;
  insideFold?: boolean;
  rowOpen: (key: string) => boolean;
  onToggleRow: (key: string) => void;
  agentSteps?: (id: string) => number;
  onSelectAgent?: (id: string) => void;
}) {
  // Surfaced even while collapsed — otherwise a group that just finished
  // showing a failing/cancelled step visually disappears the instant the
  // turn ends and the group auto-collapses back to its default.
  const hasError = toolParts.some((p) => p.isError);
  const hasInterrupted =
    !hasError && toolParts.some((p) => p.interrupted && p.output === undefined);

  const renderRow = (p: ToolPart, i: number) => {
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
  };

  // ── INSIDE AN OPEN FOLD: bare rows, because the fold row is the header ────
  //
  // The turn's fold row above already states the step count and the tally over
  // exactly these parts. Drawing the group's own summary here printed that
  // sentence twice, a few lines apart, with the second copy indented under the
  // first — which reads as two different groups that happen to agree.
  if (insideFold && !live) {
    return (
      <div
        className={cn(
          "flex w-full min-w-0 flex-col gap-0.5 text-xs",
          hasError && "text-destructive",
        )}
      >
        {toolParts.map(renderRow)}
      </div>
    );
  }

  // ── LIVE: a rolling window, not an accordion ─────────────────────────────
  //
  // The tally header ("8 steps · Ran command ×8") is deliberately absent here.
  // While the group is still growing, the tally is a number that changes every
  // few seconds and describes rows the user can already see one of; the step
  // ITSELF is the information. The header comes back the moment the turn
  // settles, below, where the tally is final and is the whole summary.
  if (live) {
    const { hidden, visible } = liveStepWindow(toolParts, open);
    const hiddenHasError = hidden.some((p) => p.isError);
    return (
      <div className={cn("flex w-full min-w-0 flex-col gap-0.5 text-xs", hasError && "text-destructive")}>
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={false}
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-muted/50"
          >
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            {/* A step that failed while scrolled out of the window must not be
                silently swallowed by the very mechanism that hid it. */}
            {hiddenHasError && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" />}
            <span className={cn("shrink-0", hiddenHasError && "text-destructive")}>
              +{hidden.length} earlier step{hidden.length === 1 ? "" : "s"}
            </span>
          </button>
        )}
        {open && toolParts.length > LIVE_STEP_WINDOW && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded
            className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-muted/50"
          >
            <ChevronRightIcon className="size-3.5 shrink-0 rotate-90 text-muted-foreground transition-transform" />
            <span className="shrink-0">Show fewer steps</span>
          </button>
        )}
        <div className="flex flex-col gap-0.5">{visible.map(renderRow)}</div>
      </div>
    );
  }

  // ── SETTLED: the tally header, collapsed by default ──────────────────────
  return (
    <div
      className={cn(
        // Activity is a stable lane inside the assistant turn. It must not hug
        // the current label: that made its width change with both tool names
        // and the prose emitted immediately before it. The low-contrast header
        // keeps the full-width lane visually light while giving every summary
        // and expanded row the same geometry.
        "flex w-full min-w-0 flex-col gap-0.5 text-xs",
        hasError && "text-destructive",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground hover:bg-muted/50"
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
        <span className="min-w-0 truncate text-muted-foreground/80">
          {toolTallyLabel(toolParts)}
        </span>
      </button>
      {open && (
        <div className="ml-2 flex flex-col gap-0.5 border-l border-border/70 pl-2">
          {toolParts.map(renderRow)}
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
/** A tools item told that it is being shown under an open fold. Rewriting the
 *  PAYLOAD (rather than reaching for shell state the turn does not own) is the
 *  sanctioned channel — behaviour reaches a renderer through its payload — and
 *  the item's `key`, its identity and the scope of its disclosure state, is
 *  untouched. */
const withOpenWork = (item: TranscriptItem): TranscriptItem =>
  item.kind === CONVERSATION_KINDS.tools
    ? { ...item, payload: { ...(item.payload as ToolsPayload), insideFold: true } }
    : item;

/** The settled turn's one-row summary of everything it took to answer. */
function TurnFoldRow({
  fold,
  expanded,
  onToggle,
}: {
  fold: SettledTurnFold;
  expanded: boolean;
  onToggle: () => void;
}) {
  const steps = fold.toolParts.length;
  const agentParts = fold.toolParts.filter(
    (part): part is ToolPart & { agent: AgentInfo } => Boolean(part.agent),
  );
  const ordinarySteps = steps - agentParts.length;
  // Errors must survive the fold. A turn whose work failed and then said
  // something reassuring would otherwise read as clean history.
  const hasError = fold.toolParts.some((p) => p.isError);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50",
        hasError && "text-destructive",
      )}
    >
      <ChevronRightIcon
        className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
      />
      {hasError && <TriangleAlertIcon className="size-3 shrink-0 text-destructive" />}
      {agentParts.length > 0 ? (
        <>
          <BotIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-foreground/80">
            {agentParts.length === 1 ? "Subagent" : `${agentParts.length} subagents`}
          </span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate text-muted-foreground/90">
            {agentParts.map((part) => agentLabel(part.agent)).join(", ")}
          </span>
          {ordinarySteps > 0 && (
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              + {ordinarySteps} step{ordinarySteps === 1 ? "" : "s"}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="shrink-0">
            {steps} step{steps === 1 ? "" : "s"}
          </span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="min-w-0 truncate text-muted-foreground/80">
            {toolTallyLabel(fold.toolParts)}
          </span>
        </>
      )}
    </button>
  );
}

const turnKind: ItemKind<TurnPayload> = {
  id: CONVERSATION_KINDS.turn,
  render: (payload, view) => {
    // SETTLED IS DERIVED, NOT DECLARED. The shell already marks exactly one
    // top-level item live (the last, and only while the owner says the surface
    // is streaming), so "assistant turn that is not live" IS "assistant turn
    // that has finished" — for the turn mid-history and the turn that ended two
    // seconds ago alike. Adding a `settled` field to the payload would have
    // made the adapter re-derive, and eventually disagree with, a fact the
    // shell was already computing correctly.
    const fold =
      payload.from === "assistant" && !view.live ? foldSettledTurn(payload.items) : null;
    const expanded = view.isOpen("fold");
    // Opening the fold means "show me the work", so the groups it un-hides come
    // back OPEN. Left to their own default they would each re-collapse behind a
    // tally header — and since the phase-1 grouping fix usually leaves a settled
    // turn with exactly ONE group, that header is the fold row's own label
    // repeated verbatim one line below it. Answering a click with a copy of the
    // thing clicked is worse than not having the fold at all.
    const shown = !fold
      ? payload.items
      : expanded
        ? [...fold.hidden.map(withOpenWork), ...fold.tail]
        : fold.tail;
    return (
      <Message from={payload.from}>
        <MessageContent>
          {payload.items.length === 0 ? (
            payload.pending
          ) : (
            <>
              {fold && (
                <TurnFoldRow
                  fold={fold}
                  expanded={expanded}
                  onToggle={() => view.setOpen("fold", !expanded)}
                />
              )}
              {/* `isTrailingItem` runs over what is ACTUALLY rendered, not over
                  `payload.items` — with a fold collapsed the two differ, and
                  liveness computed against the wrong array would name an index
                  that is not on screen. */}
              {shown.map((child, i) =>
                view.render(child, { live: view.live && isTrailingItem(shown, i) }),
              )}
            </>
          )}
        </MessageContent>
      </Message>
    );
  },
};

const textKind: ItemKind<TextPayload> = {
  id: CONVERSATION_KINDS.text,
  render: (payload) => <MessageResponse>{payload.text}</MessageResponse>,
};

/** Bytes → a chip-sized label, matching the composer's staged chips. */
function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * One persisted attachment.
 *
 * THE TOMBSTONE IS THE INTERESTING CASE. Archiving a chat destroys its bytes
 * while this part survives in the transcript (see lib/attachments.ts), so a chip
 * must be able to say "this was here and is gone" rather than showing a broken
 * image. For an image that costs nothing: the thumbnail request either succeeds
 * or fires `onError`, and there is no extra probe either way. A non-image never
 * claims liveness in the first place — it renders as a name and a size, which
 * stay true forever.
 */
function AttachmentChip({ item }: { item: AttachmentRef }) {
  const [missing, setMissing] = useState(false);
  const isImage = item.mediaType.startsWith("image/");

  return (
    <span
      className={cn(
        "flex max-w-56 items-center gap-2 rounded-lg bg-background/70 py-1 pl-1 pr-2 ring-1 ring-border",
        missing && "opacity-60",
      )}
      title={missing ? `${item.name} — no longer available` : item.name}
    >
      {isImage && !missing ? (
        // A user-uploaded blob of unknown dimensions served from this app;
        // next/image would need a loader and a size for something that may not
        // exist any more. The directive must be the LAST line before the
        // element — "next-line" means the next LINE, so stacking it above more
        // comment lines disables nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt={item.name}
          className="size-8 shrink-0 rounded-md object-cover"
          onError={() => setMissing(true)}
          src={attachmentUrl(item.id)}
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {missing ? <TriangleAlertIcon className="size-4" /> : <PaperclipIcon className="size-4" />}
        </span>
      )}
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium">{item.name}</span>
        <span className="text-[10px] text-muted-foreground">
          {missing ? "no longer available" : attachmentSize(item.size)}
        </span>
      </span>
    </span>
  );
}

const attachmentsKind: ItemKind<AttachmentsPayload> = {
  id: CONVERSATION_KINDS.attachments,
  render: (payload) => (
    <div className="flex flex-wrap gap-1.5">
      {payload.files.map((item) => (
        <AttachmentChip item={item} key={item.id} />
      ))}
    </div>
  ),
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
  // EVERY group now defaults CLOSED, live or not — the live default used to be
  // OPEN so the user could watch steps arrive, and the rolling window serves
  // that need without the wall of rows (see ToolStepGroup's live branch).
  //
  // The two meanings of `open` share one key ON PURPOSE: live it means "show
  // the earlier steps too", settled it means "show the steps at all". A user
  // who expanded a group mid-turn keeps it expanded when the turn ends, which
  // is the continuity they asked for by clicking.
  render: (payload, view) => (
    <ToolStepGroup
      toolParts={payload.parts}
      open={view.isOpen("group")}
      live={view.live}
      insideFold={payload.insideFold}
      onToggle={() => view.setOpen("group", !view.isOpen("group"))}
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
        agentId={part.agentId}
        onRespond={
          onRespond
            ? (behavior, always, rule) => onRespond(part.id, behavior, always, rule)
            : undefined
        }
      />
    );
  },
};

// Shipped with no production producer, and that was correct rather than
// speculative: it had two consumers on day one — the gallery lane, and the
// shell's own tombstone for an unregistered kind — and it is the shape Track F's
// `loom:*` markers will copy. "Born on it rather than migrated to it" is the
// whole point of epic 3. The first production producer arrived with issue #25:
// session-view.tsx's compaction divider, interleaved between turns.
const markerKind: ItemKind<MarkerPayload> = {
  id: CONVERSATION_KINDS.marker,
  render: (payload) => {
    const { display, onSelectAgent } = payload;
    // Plain text unless every merged completion carries provenance AND the
    // surface is interactive — the same degradation mechanism as a
    // permission card without onRespond.
    if (!display || !onSelectAgent) {
      return <Marker attention={payload.attention}>{payload.text}</Marker>;
    }
    return (
      <Marker attention={payload.attention}>
        {display.lead}
        {display.agents.map((a) => (
          <span key={a.id} className="flex items-center gap-1.5">
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => onSelectAgent(a.id)}
              className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {a.label}
            </button>
          </span>
        ))}
        {display.extra > 0 ? <span>· +{display.extra} more</span> : null}
      </Marker>
    );
  },
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

/** The eight built-ins, ready to spread into an owner adapter's own registry. */
export const BUILTIN_KINDS: readonly ItemKind<never>[] = [
  turnKind,
  textKind,
  thinkingKind,
  toolsKind,
  permissionKind,
  markerKind,
  statusKind,
  attachmentsKind,
] as unknown as readonly ItemKind<never>[];
