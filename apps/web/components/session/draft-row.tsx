"use client";

/**
 * A conversation you started writing and did not send.
 *
 * SMALLER THAN A SESSION, ON PURPOSE, AND THAT IS THE WHOLE DESIGN. A session
 * row spends three lines on project, title, branch and provider because a
 * session has all of those. A draft has none of them — no id, no branch, no
 * provider, no activity, nothing an engine has ever heard of. It is a sentence
 * you typed. So it costs ONE line, roughly half a card, and reads as a scrap
 * pinned above the list rather than a fifth kind of session in it.
 *
 * NOT A `SessionRow` VARIANT. That component's body assumes a real
 * `SidebarSession` — `activity`, `driver`, `updatedAt`, a `sessionHref` — and a
 * third variant would mean threading "but not this one" through every branch of
 * it. The two rows share the rail's hover and accent grammar, which is the part
 * that has to match; they do not share a component.
 */

import Link from "next/link";
import { SquarePenIcon, XIcon } from "lucide-react";
import { canvasHref } from "@/lib/session-list";

export function DraftRow({
  projectId,
  projectName,
  text,
  active,
  showProject,
  onNavigate,
  onDiscard,
}: {
  projectId: string;
  /** Absent when the project is gone from the registry — the row still opens. */
  projectName?: string;
  text: string;
  active: boolean;
  /** Matches the session rows: named only when the rail is not already scoped. */
  showProject: boolean;
  onNavigate: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={`group/draft relative flex items-center rounded-md ${
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"
      }`}
    >
      <Link
        href={canvasHref(projectId)}
        onClick={onNavigate}
        // py-1 is `slim`'s own padding — the smallest volume the rail already
        // uses. A draft should never be taller than the settled sessions below
        // it, and this is how that stays true if slim ever changes.
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* The mark that says "unsent" without spending a word on it. Kept at
            full opacity while everything beside it is dimmed: the icon IS the
            row's label, since there is no band heading above these. */}
        <SquarePenIcon aria-hidden className="size-3 shrink-0 text-sidebar-foreground/50" />
        {/* Only the word the glyph is standing in for. The project is either
            named right beside this or implied by the scope the rail is already
            in, so repeating it here read as "Draft in Telar: Telar ·". */}
        <span className="sr-only">Draft: </span>
        {showProject && projectName ? (
          <>
            <span className="shrink-0 truncate text-[11px] text-sidebar-foreground/50">{projectName}</span>
            <span aria-hidden className="shrink-0 text-[11px] text-sidebar-foreground/25">
              ·
            </span>
          </>
        ) : null}
        {/* THE TEXT IS THE TITLE, because a draft has no other name and asking
            for one before you have finished the thought is the kind of ceremony
            that stops people writing. Single line, truncated — the rest of it
            is one click away. */}
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground/60 group-hover/draft:text-sidebar-foreground">
          {text}
        </span>
      </Link>
      {/* DISCARDING HAS TO BE POSSIBLE. A list you cannot remove things from
          fills up and then gets ignored, and "send it to be rid of it" is not
          an option for a paragraph you decided against. Hidden until hover for
          the same reason the session actions are: it is the rare intent. */}
      <button
        type="button"
        aria-label={`Discard draft${projectName ? ` in ${projectName}` : ""}`}
        title="Discard draft"
        onClick={onDiscard}
        className="absolute right-1 rounded p-0.5 text-sidebar-foreground/45 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-focus-within/draft:opacity-100 group-hover/draft:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
