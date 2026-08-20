"use client";

/**
 * THE SPOOL'S ONE TOP BAR.
 *
 * WHY IT IS A COMPONENT AND NOT TWO CALLS TO `PageHeader`. It was two, and they
 * had drifted into different objects: the queue wore the full page chrome —
 * sidebar trigger, title, a live count, an action — while the chat rendered a
 * bare tab group with no header at all, so its tabs floated at the top of the
 * viewport with no hairline under them and no way to reach the sidebar. Two
 * halves of ONE destination cannot introduce themselves differently.
 *
 * ── THE CHAT|QUEUE TABS ARE GONE, AND THE SPOOL IS ONE VIEW ──────────────────
 * They existed because the queue was a second page. §13 retired it as a
 * destination entirely: the stance's bands absorbed it, the inventory survives
 * as a panel fold, and the conversation stands beside the stance rather than
 * behind a tab. A tab strip here would name two things that are not siblings —
 * a destination and a tool.
 *
 * ── THERE IS NO ACTIONS SLOT, AND THAT ABSENCE IS THE POINT ──────────────────
 * There was one, and the queue put "+ Lane" in it. The cost was immediate: the
 * button exists on the queue and not on the chat, so the tabs MOVED SIDEWAYS as
 * you switched — a surface-specific action shoving shared navigation around, so
 * the control you were aiming at had relocated by the time the page arrived.
 * The slot is REMOVED rather than left empty, because a slot that must never be
 * used by one caller and may be used by another is a rule nobody can see.
 *
 * ── THE DESCRIPTION IS PER SURFACE AND ALWAYS A FACT ─────────────────────────
 * The queue states a live count; the chat states what it is. Neither instructs,
 * and neither counts anything AT the user — the module answers when arrived at,
 * so a number here describes what is already on this screen rather than telling
 * you there is something elsewhere to attend to.
 */
import type { ReactNode } from "react";
import { SpoolIcon } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";

export function SpoolHeader({
  description,
  leading,
}: {
  /** What THIS surface is, in one short line. Absent renders the row without
   *  it rather than reserving an empty second line — `PageHeader`'s own floor
   *  keeps a description-less header the same height as one with it. */
  description?: ReactNode;
  /** The way back, for a surface that is not the front door. */
  leading?: ReactNode;
}) {
  return (
    <PageHeader
      /**
       * THE MARK CARRIES `--spool` — the first of the five places the room
       * colour is allowed, and the one that does the most work: it is the thing
       * you see before you have read a word. The previous differentiator was
       * `bg-muted/25` on the ground, one value step, measurably invisible in a
       * screenshot.
       */
      title={
        <span className="flex items-center gap-2">
          <SpoolIcon className="size-4 shrink-0 text-spool" />
          Spool
        </span>
      }
      {...(description === undefined ? {} : { description })}
      {...(leading === undefined ? {} : { leading })}
    />
  );
}
