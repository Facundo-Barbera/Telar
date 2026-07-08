"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ShieldAlertIcon } from "lucide-react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

// Claude Code spawns subagents through a tool call; every subsequent message
// the subagent produces carries that tool_use id as its parent_tool_use_id.
// Keying tabs (and, later, a full multi-agent view) by that id — rather than
// a synthetic tab record — means N concurrent agents are just N ids seen in
// the transcript, with zero extra bookkeeping.
export type AgentTabStatus = "running" | "done" | "error";

export type AgentTab = {
  id: string;
  label: string;
  status: AgentTabStatus;
};

// A small filled dot, shimmering while the spawn's tool_result hasn't landed
// yet. Reused on the tab strip and on the main-thread agent chip (B.3 group)
// so "this subagent is still working" reads identically in both places.
//
// Deliberately NOT a keyframe opacity fade — WebKit 26.x crashes on those for
// fixed/absolute layers. Shimmer instead animates a background-position
// gradient behind clipped text, which is what the rest of the app already
// uses for its busy states (see the heartbeat bar / tool-step rows).
export function StatusDot({ status, className }: { status: AgentTabStatus; className?: string }) {
  if (status === "running") {
    return (
      <Shimmer as="span" className={cn("text-[10px] leading-none", className)}>
        ●
      </Shimmer>
    );
  }
  return (
    <span
      className={cn(
        "text-[10px] leading-none",
        status === "error" ? "text-destructive" : "text-muted-foreground/40",
        className,
      )}
    >
      ●
    </span>
  );
}

// The strip between the heartbeat bar and the conversation. "Main" is always
// present; a tab for a spawn appears the instant its tool-call part arrives
// (live streaming) or is reconstructed from persisted parts on load — there
// is no separate tab record anywhere, `tabs` is derived fresh every render.
//
// Switching is pure state (activeId is owned by the caller) — no
// element.focus() call anywhere here, including on click: browsers already
// focus a clicked button on their own, and WebKit 26.x's crash is specifically
// on *programmatic* .focus(), so it's the manual roving-tabindex pattern
// (moving focus on ArrowLeft/ArrowRight) that's avoided, not click focus.
// Arrow-key switching below only ever updates `activeId` — the key handler
// never calls .focus(), so keyboard focus simply stays put on whichever tab
// button already has it while the *selected* tab (visual state) moves.
export function AgentTabsStrip({
  tabs,
  activeId,
  onSelect,
  mainNeedsAttention,
  availableAgents,
}: {
  tabs: AgentTab[];
  activeId: string;
  onSelect: (id: string) => void;
  mainNeedsAttention?: boolean;
  availableAgents?: string[];
}) {
  const order = ["main", ...tabs.map((t) => t.id)];

  // Keyed off `activeId` (the currently-SELECTED tab), not the id of
  // whichever button the keydown physically landed on. Real DOM focus never
  // follows `activeId` here (no .focus() call, on purpose — see the WebKit
  // note above), so a naive per-button-id lookup would keep recomputing
  // "next" from wherever focus happened to land on the last click/Tab, not
  // from the tab the user just arrowed to — with 3+ tabs that strands
  // keyboard users oscillating between only two of them. Deriving from
  // `activeId` instead means each arrow press always advances relative to
  // the tab actually shown as selected, regardless of literal DOM focus.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = order.indexOf(activeId);
    const next = e.key === "ArrowRight" ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
    onSelect(order[next]);
  };

  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1 text-xs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeId === "main"}
        tabIndex={activeId === "main" ? 0 : -1}
        onClick={() => onSelect("main")}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
          activeId === "main"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        {mainNeedsAttention && (
          <ShieldAlertIcon className="size-3 shrink-0 text-destructive" />
        )}
        Main
      </button>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={activeId === t.id}
          tabIndex={activeId === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
            activeId === t.id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <StatusDot status={t.status} />
          <span className="max-w-40 truncate">{t.label}</span>
        </button>
      ))}
      {availableAgents && availableAgents.length > 0 && (
        // min-w-0 (not shrink-0 — flex-shrink defaults to 1 already): a flex
        // item's min-width is otherwise "auto" (its content's natural
        // width), which blocks it from ever shrinking narrower than that —
        // the same thing `truncate`'s overflow-hidden needs room to kick in.
        // shrink-0 here previously pinned it at full width, making
        // `truncate` permanently inert.
        <span className="ml-auto min-w-0 truncate pl-2 text-[10px] text-muted-foreground/60">
          subagents available: {availableAgents.join(", ")}
        </span>
      )}
    </div>
  );
}
