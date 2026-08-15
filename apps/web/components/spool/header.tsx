"use client";

/**
 * THE SPOOL'S ONE TOP BAR, worn by both of its surfaces.
 *
 * WHY IT IS A COMPONENT AND NOT TWO CALLS TO `PageHeader`. It was two, and they
 * had drifted into different objects: the queue wore the full page chrome —
 * sidebar trigger, title, a live count, an action — while the chat rendered a
 * bare tab group with no header at all, so its tabs floated at the top of the
 * viewport with no hairline under them and no way to reach the sidebar. Two
 * halves of ONE destination cannot introduce themselves differently.
 *
 * ── THE LAYOUT, AND WHY THIS ORDER ───────────────────────────────────────────
 * `[☰] Spool · <what this surface is> ............ [Chat|Queue] [actions]`
 *
 * IDENTITY FIRST, NAVIGATION SECOND. The tabs used to sit in `PageHeader`'s
 * `leading` slot, which put them BEFORE the title — you read "Chat | Queue"
 * before you read what they were tabs of. Moving them to the right of the
 * description restores the ordinary reading order, and it puts the two controls
 * that CHANGE something — the tab group and the surface's own action — together
 * at the end of the row where a hand looks for them.
 *
 * ── THE DESCRIPTION IS PER SURFACE AND ALWAYS A FACT ─────────────────────────
 * The queue states a live count; the chat states what it is. Neither instructs,
 * and neither counts anything AT the user — the module answers when arrived at,
 * so a number here describes what is already on this screen rather than telling
 * you there is something elsewhere to attend to.
 */
import type { ReactNode } from "react";
import { PageHeader } from "@/components/common/page-header";
import { SpoolTabs } from "@/components/spool/tabs";

export function SpoolHeader({
  active,
  description,
  actions,
}: {
  active: "chat" | "queue";
  /** What THIS surface is, in one short line. Absent renders the row without
   *  it rather than reserving an empty second line — `PageHeader`'s own floor
   *  keeps a description-less header the same height as one with it. */
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <PageHeader
      title="Spool"
      {...(description === undefined ? {} : { description })}
      actions={
        <>
          <SpoolTabs active={active} />
          {actions}
        </>
      }
    />
  );
}
