"use client";
// LANE: workspace (CONCEPT) — the four mockups' shared vocabulary.
//
// RE-SKIN PASS (2026-08-08). When these prototypes were drawn (25 Jul) nothing
// under components/workspace/ existed, so this file spelled the chip grammar by
// hand. IT IS PRODUCTION CODE NOW — components/workspace/chips.tsx, frozen by
// ui-contract.md §"Chip grammar" — and the prototypes RE-EXPORT it instead of
// keeping a second copy that can only drift.
//
// THE IMPORT DIRECTION IS THE WHOLE POINT. Production may never import a demo
// (demo-gallery rule 7, asserted by lib/workspace-ui-idiom.test.ts's "production
// never imports the demo prototypes"); a DEMO importing production is the
// opposite arrow and is how a prototype stays honest about what the app
// actually looks like. It also makes cross-surface invariant 1 — "deadline,
// verdict, project and provenance render identically on every surface" — true
// of the prototypes by construction rather than by two authors agreeing.
//
// WHAT WAS DELETED HERE, AND WHY IT HAD TO BE. The hand-spelled copies carried
// exactly the pre-token scale chips.tsx's own header names as the thing it
// deliberately did NOT copy: bare `rounded` (an off-scale 0.25rem), the 9px
// provenance label, `border-border/60`, `text-foreground/80`. Keeping them
// meant the design source-of-truth was the one place in the repo still showing
// the app the wrong way round. The GEOMETRY these prototypes own — which chip
// is solid, which is dashed, what suffix it carries — is unchanged, because it
// is the same module drawing it.
export {
  DeadlineChip,
  ProjectChip,
  ProvenanceTag,
  ToolPill,
  VerdictChip,
} from "@/components/workspace/chips";

import type { ReactNode } from "react";
import { ListTodoIcon, MessageSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The Workspace surface's internal nav: chat is the front door, the queue is
// the drawer behind it. One surface, two tabs — how the "other elements" are
// reached without the queue pretending to be a top-level destination.
//
// THE ONE CHIP-GRAMMAR SIBLING THAT IS NOT RE-EXPORTED, and the divergence is
// deliberate. The production twin (chips.tsx's WorkspaceTabs) renders Chat
// INERT — `cursor-not-allowed opacity-60`, no href — because the chat page does
// not exist yet and a real link would be a promise story 5.3 does not keep.
// These mockups ARE the design source for that page, so both tabs render as
// live segments. Every class below is the production string verbatim (`base` /
// `on` / `off`, including the `transition-colors` + `hover:bg-muted/60` hover
// convention), so the two copies can disagree about exactly one thing: whether
// Chat exists. Neither tab is a <Link> — a gallery stage must not navigate off
// itself.
export function WorkspaceTabs({ active }: { active: "chat" | "queue" }) {
  const base =
    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors";
  const on = "bg-muted font-medium text-foreground";
  const off = "text-muted-foreground hover:bg-muted/60 hover:text-foreground";
  const tab = (key: "chat" | "queue", label: string, Icon: typeof ListTodoIcon) => (
    <span
      aria-current={active === key ? "page" : undefined}
      className={cn(base, active === key ? on : off)}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  );
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {tab("chat", "Chat", MessageSquareIcon)}
      {tab("queue", "Queue", ListTodoIcon)}
    </div>
  );
}

// The app's section label: 10px, MEDIUM (not semibold — semibold is
// GroupHeader's register, one level up), uppercase, wide tracking, muted/70.
// Element, classes and the `mb-2` are components/workspace/packet-view.tsx's
// SectionLabel verbatim, which took them from ultra-rail.tsx's "Workflows"
// heading; that sameness is what makes a packet's columns read as the same
// system as a rail's. The prototypes' own copies were `font-semibold` — one
// register too loud, and the drift this re-export exists to end.
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h2>
  );
}
