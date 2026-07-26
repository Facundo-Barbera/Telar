"use client";

// LANE: conversation (UX BRAINSTORM 2026-07-23) — the six configurations the six
// hand-rebuilt chat lanes need, all rendered by the ONE REAL SHELL against local
// fixtures. This is the "before any production surface depends on it" half of
// epic 3: epics 4, 5 and 6 build their owner adapters against what they can see
// here, in parallel, without coordinating.
//
// The shell is imported from "@/components/conversation" — the same single
// import path a production surface uses. Nothing here is a copy of it, and
// nothing here is a copy of a kind: the registry below is the real factory over
// the real built-ins, so a contract change breaks this lane loudly.

import { useState } from "react";
import {
  ADVANCE_APPROVAL_LABELS,
  ApprovalCard,
  BUILTIN_KINDS,
  CONVERSATION_KINDS,
  Conversation,
  ConversationEmptyState,
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  createItemKindRegistry,
  type PermissionPayload,
  type TranscriptItem,
} from "@/components/conversation";
import { SubagentRail, type RailAgent } from "@/components/session/subagent-rail";
import { cn } from "@/lib/utils";
import {
  CONVERSATION_FIXTURES,
  PENDING_PERMISSION,
  type ConversationConfig,
} from "./fixtures";

// The real factory, over the real built-ins. `ultra:run-anchor` is deliberately
// absent so configuration 6 can show the tombstone.
export const GALLERY_KINDS = createItemKindRegistry([...BUILTIN_KINDS]);

const RAIL_AGENTS: RailAgent[] = [
  { id: "a1", label: "carve the render seam", tool: "general-purpose", status: "running", steps: 14, activity: "Edit · components/conversation/kinds.tsx" },
  { id: "a2", label: "context inventory", tool: "Explore", status: "done", steps: 9 },
  { id: "a3", label: "lint delta", tool: "general-purpose", status: "error", steps: 3 },
];

// ── slot content ────────────────────────────────────────────────────────────

function LaneHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{note}</span>
    </div>
  );
}

function FullComposer({ placeholder }: { placeholder: string }) {
  return (
    <div className="relative mx-auto w-full max-w-7xl px-4 pb-4">
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea className="min-h-10" placeholder={placeholder} />
        </PromptInputBody>
        <PromptInputFooter className="flex-wrap">
          <PromptInputTools className="flex-wrap">
            <span className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
              Claude
            </span>
            <span className="flex h-8 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground">
              Auto
            </span>
          </PromptInputTools>
          <PromptInputSubmit className="ml-auto shrink-0 self-end" />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

function MinimalComposer({ placeholder }: { placeholder: string }) {
  return (
    <div className="relative mx-auto w-full max-w-7xl px-4 pb-4">
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea className="min-h-10" placeholder={placeholder} />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="text-[10px] text-muted-foreground">talking is free</span>
          <PromptInputSubmit className="ml-auto shrink-0 self-end" />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

// A DIFFERENT rail in the same slot — the point of "one slot, many rails".
function DeskRail() {
  const rows: Array<[string, string, string]> = [
    ["client nav variant", "weaving", "text-muted-foreground"],
    ["prd alignment", "parked", "text-amber-600 dark:text-amber-400"],
    ["auth rollover", "ready", "text-emerald-600 dark:text-emerald-400"],
  ];
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1.5 border-l px-2.5 py-3">
      <p className="px-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
        desk
      </p>
      {rows.map(([label, state, tone]) => (
        <div key={label} className="rounded-lg border bg-muted/20 px-2.5 py-2">
          <p className="truncate text-xs font-medium">{label}</p>
          <p className={cn("font-mono text-[10px]", tone)}>{state}</p>
        </div>
      ))}
    </aside>
  );
}

// ── the lane ────────────────────────────────────────────────────────────────

/** Inject a live `onRespond` (and the locally-tracked resolution) into every
 *  permission payload, recursively. The READ-ONLY configuration deliberately
 *  skips this — which is the whole demonstration: the same items, minus one
 *  callback, render as a non-interactive transcript. */
function withRespond(
  items: readonly TranscriptItem[],
  resolved: Record<string, "allowed" | "denied">,
  onRespond: PermissionPayload["onRespond"],
): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === CONVERSATION_KINDS.permission) {
      const payload = item.payload as PermissionPayload;
      const status = resolved[payload.part.id] ?? payload.part.status;
      return { ...item, payload: { part: { ...payload.part, status }, onRespond } };
    }
    const nested = (item.payload as { items?: readonly TranscriptItem[] }).items;
    if (Array.isArray(nested)) {
      return {
        ...item,
        payload: { ...(item.payload as object), items: withRespond(nested, resolved, onRespond) },
      };
    }
    return item;
  });
}

function ConversationLane({
  config,
  header,
  composer,
  rail,
  trailing,
  readOnly,
  empty,
}: {
  config: ConversationConfig;
  header?: React.ReactNode;
  composer?: React.ReactNode;
  rail?: React.ReactNode;
  trailing?: React.ReactNode;
  readOnly?: boolean;
  empty?: React.ReactNode;
}) {
  const [resolved, setResolved] = useState<Record<string, "allowed" | "denied">>({});
  const source = CONVERSATION_FIXTURES[config];
  const items = readOnly
    ? source
    : withRespond(source, resolved, (id, behavior) =>
        setResolved((prev) => ({ ...prev, [id]: behavior === "allow" ? "allowed" : "denied" })),
      );

  return (
    <div className="flex h-full flex-col bg-background">
      <Conversation
        items={items}
        kinds={GALLERY_KINDS}
        header={header}
        composer={composer}
        rail={rail}
        trailing={trailing}
        empty={empty}
      />
    </div>
  );
}

// 1 — the donor: header + full composer + the production rail, every kind.
export function ConversationFullDemo() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ConversationLane
      config="conversation-full"
      header={<LaneHeader title="Project session" note="header · composer · rail · every kind" />}
      composer={<FullComposer placeholder="Ask about telar… (“/” for commands)" />}
      rail={
        <SubagentRail
          agents={RAIL_AGENTS}
          activeId="main"
          onSelect={() => {}}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
          sessionLabel="Carve out the conversation shell"
          mainNeedsAttention
        />
      }
    />
  );
}

// 2 — loom node chats: no header, no rail, a bare composer.
export function ConversationMinimalDemo() {
  return (
    <ConversationLane
      config="conversation-minimal"
      composer={<MinimalComposer placeholder="Message this node…" />}
    />
  );
}

// 3 — TranscriptView: NO composer, no rail, every kind still renders.
export function ConversationReadOnlyDemo() {
  return (
    <ConversationLane
      config="conversation-readonly"
      readOnly
      header={<LaneHeader title="Agent transcript" note="no composer · no rail · read-only approvals" />}
    />
  );
}

// 4 — master chat's Desk: the same slot, a different rail.
export function ConversationRailDeskDemo() {
  return (
    <ConversationLane
      config="conversation-rail-desk"
      header={<LaneHeader title="Master chat" note="one slot, many rails" />}
      composer={<FullComposer placeholder="Ask across the workspace…" />}
      rail={<DeskRail />}
    />
  );
}

// 5 — the gate room: an approval last, in BOTH label vocabularies.
export function ConversationApprovalDemo() {
  const [advance, setAdvance] = useState<"pending" | "allowed" | "denied">("pending");
  return (
    <ConversationLane
      config="conversation-approval"
      header={<LaneHeader title="Gate room" note="one component · two vocabularies" />}
      composer={<MinimalComposer placeholder="Message the gate…" />}
      trailing={
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 pt-3">
          <ApprovalCard
            header="node advance — awaiting your approval"
            title="prd-alignment"
            preview={String(PENDING_PERMISSION.input.file_path)}
            status={advance}
            labels={ADVANCE_APPROVAL_LABELS}
            onRespond={(behavior) => setAdvance(behavior === "allow" ? "allowed" : "denied")}
          />
        </div>
      }
    />
  );
}

// 6 — the degradation contract: the empty state, and an unregistered kind
// rendering its tombstone beside items that render fine.
export function ConversationEmptyAndTombstoneDemo() {
  const [showEmpty, setShowEmpty] = useState(false);
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
        <button
          type="button"
          onClick={() => setShowEmpty((v) => !v)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted/60"
        >
          {showEmpty ? "Show the tombstone transcript" : "Show the empty state"}
        </button>
        <span className="font-mono text-[10px] text-muted-foreground">
          AD-8 · a dangling reference is a tombstone, never a throw
        </span>
      </div>
      <Conversation
        items={showEmpty ? [] : CONVERSATION_FIXTURES["conversation-empty-and-tombstone"]}
        kinds={GALLERY_KINDS}
        empty={
          <ConversationEmptyState
            title="Work in this repo"
            description="Ask about the code, plan a change, or make edits directly. Reads run freely; writes and commands ask for your approval — or go automatically in Auto mode."
          />
        }
        composer={<MinimalComposer placeholder="Say something…" />}
      />
    </div>
  );
}
