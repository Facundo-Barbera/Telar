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
import { ListTodoIcon, MessageSquareIcon, WorkflowIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The Workspace surface's internal nav: chat is the front door, the queue is
// the drawer behind it. One surface, two tabs — how the "other elements" are
// reached without the queue pretending to be a top-level destination.
//
// THE FIRST OF THE TWO chips.tsx SIBLINGS THAT ARE NOT RE-EXPORTED (the other
// is TrackingChip, below), and both are held back for the SAME reason — the
// production twin navigates and a gallery stage may not. Everything else in
// that module is a pure span and comes across by re-export.
//
// The production twin used to render Chat INERT — `cursor-not-allowed
// opacity-60`, no href — because the chat page did not exist and a real link
// would have been a promise story 5.3 could not keep. STORY 5.7 BUILT THE PAGE
// — as the workspace ROOT (app/workspace/page.tsx), with the queue moved down
// to app/workspace/queue, because ui-contract.md's shell sentence makes chat
// the front door and the queue the drawer behind it. So both halves of the
// production control are now real <Link>s and the only difference left is the
// one below: a gallery stage must not navigate off itself, so these two are
// spans.
// Every class below is the production string verbatim (`base` /
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

// THE SENT-TO-LOOM MARK — the second held-back sibling, and the one the queue
// needs to keep ui-contract.md §3's last bullet true on screen: "after a weave
// the member rows STAY in the queue, marked as tracking the loom." The
// sentence survives in DetachReceipt's quiet second line (detach-receipt.ts's
// trackingNote); this is the MARK, which a sentence in a receipt is not.
//
// THE DIVERGENCE IS THE ELEMENT AND NOTHING ELSE. chips.tsx's TrackingChip is
// a <Link> to `/looms/{id}`; a gallery stage must not navigate off itself (the
// same rule that keeps the tabs above inert), and the fixture loom id does not
// resolve to anything anyway. So this renders a <span> with the production
// className and title strings VERBATIM — asserted character-for-character by
// idiom.test.ts, which reads both files — and therefore diverges in exactly
// one thing: whether it is clickable.
//
// The grammar it carries across is chips.tsx's, unchanged: neutral outline
// body, hue on the ICON alone, mono 10px, and `--info` rather than `--success`
// because the loom is IN FLIGHT — a green tick would read as the acceptance
// only a human can give (AD-8).
export function TrackingChip({ loomId, label }: { loomId: string; label?: string }) {
  return (
    <span
      title={
        label
          ? `Sent to loom ${loomId} — “${label}” · this row stays here until the loom lands and you accept it`
          : `Sent to loom ${loomId} — this row stays here until the loom lands and you accept it`
      }
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      <WorkflowIcon className="size-2.5 text-info" />
      at loom
    </span>
  );
}

// The app's section label: 10px, MEDIUM (not semibold — semibold is
// GroupHeader's register, one level up), uppercase, wide tracking, muted/70.
// Element, classes and the `mb-2` are components/workspace/packet-view.tsx's
// SectionLabel verbatim, which took them from ultra-rail.tsx's "Workflows"
// heading; that sameness is what makes a packet's columns read as the same
// system as a rail's. The prototypes' own copies were `font-semibold` — one
// register too loud, and the drift this re-export exists to end.
//
// `className` IS THE ONLY ADDITION, and it exists so that having this component
// is never harder than re-typing its class list. The production twin is
// module-private and every one of its uses is a block heading where the `mb-2`
// is right; the Desk rail's header is a FLEX ROW (label beside a count), where
// the same margin pushes the label off the baseline. Without an override the
// rail hand-rolled the h2 instead — a copy that matched today and could only
// diverge later, which is the exact failure this file exists to prevent.
// Merged through cn(), so an override wins on the same property and the rest
// of the register is inherited rather than restated.
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70",
        className,
      )}
    >
      {children}
    </h2>
  );
}
