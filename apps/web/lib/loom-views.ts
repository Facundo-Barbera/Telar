import { FileTextIcon, LayoutListIcon, MessagesSquareIcon, ScrollTextIcon } from "lucide-react";

/**
 * THE FOUR SEGMENTS OF `/looms/[projectId]`, AS DATA.
 *
 * One array, one union derived from it, one place to add a fifth — the shape
 * `right-panel.tsx` spells its tabs in, and what makes a new segment an
 * addition rather than a refactor.
 *
 * EXACTLY ONE IS ON SCREEN AT A TIME. That is the whole point of this file
 * existing: the page is the app sidebar plus ONE content column, never a third,
 * and a segment is how a fourth thing gets shown without becoming a fourth
 * column. `components/loom/idiom.test.ts` pins the rule.
 *
 * ── WHY THIS IS NOT IN `orchestrator.tsx` ────────────────────────────────────
 * That file is `"use client"`, and a function exported from a client module is
 * a CLIENT REFERENCE on the server, not a function. The page reads `?view=`
 * during rendering and must call `loomView` for real, so the parser lives in a
 * module both sides can actually run. This was a 500, not a theory.
 */
export const LOOM_VIEWS = [
  { id: "deck", label: "Deck", icon: LayoutListIcon },
  { id: "program", label: "Program", icon: FileTextIcon },
  { id: "ledger", label: "Ledger", icon: ScrollTextIcon },
  { id: "conversation", label: "Conversation", icon: MessagesSquareIcon },
] as const;

export type LoomView = (typeof LOOM_VIEWS)[number]["id"];

/** The link for one segment. `deck` is the bare address, so the default view
 *  has one URL rather than two that render the same thing. */
export function loomViewHref(projectId: string, view: LoomView): string {
  const base = `/looms/${encodeURIComponent(projectId)}`;
  return view === "deck" ? base : `${base}?view=${view}`;
}

/** An unknown or absent `?view=` is the Deck, never an error page — a shared
 *  link that outlives a segment name should land somewhere useful. */
export function loomView(value?: string | string[]): LoomView {
  const first = Array.isArray(value) ? value[0] : value;
  return LOOM_VIEWS.some((view) => view.id === first) ? (first as LoomView) : "deck";
}
