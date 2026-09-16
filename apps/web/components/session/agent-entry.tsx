"use client";

/**
 * THE AGENT, pinned above the bands and below Search — experimental, and drawn
 * only when the Mac you are looking at has one switched on (#531).
 *
 * ── WHAT CHANGED FROM THE MAIN ENTRY THIS REPLACES ──────────────────────────
 * THERE IS NO SESSION BEHIND IT, and that is the whole difference. Main's row
 * was a conversation the rail already held: the entry found it by id among the
 * rows, took its title, and linked at `sessionHref`. So it could not be drawn
 * until the list had loaded, it disappeared if the designated conversation fell
 * off the page, and it showed whatever the person had renamed that session to.
 *
 * The Agent is not a session. It has its own identity and its own thread, there
 * is no id in the rail's namespace to find, and the row needs nothing from the
 * list at all — one flag off the live read, a fixed word, and a fixed address.
 * That makes it strictly simpler and strictly more reliable: it is drawn the
 * moment the engine says the Agent exists, and nothing about the session list
 * can take it away.
 *
 * ── IT FOLLOWS THE VIEWED MAC, WHICH MAIN'S ROW DID NOT ─────────────────────
 * Main's entry was the LOCAL Mac's coordinator and only ever that: "the
 * conversation I coordinate from" is a fact about the cockpit you are sitting
 * in. The Agent's row is per MACHINE — each paired Mac has its own, and the
 * issue asks for the entry to be the VIEWED host's.
 *
 * So the flag is read per host and the row is the one for whichever Mac the
 * address bar is about. Walking into `/hosts/<id>/…` swaps which Agent this row
 * opens, exactly as it swaps which sessions the rail is showing you. A Mac with
 * the Agent switched off has no row while you are looking at it, which is the
 * honest answer rather than a link into an empty screen.
 *
 * ── ONE LINE, LIKE A DRAFT ROW ──────────────────────────────────────────────
 * `SessionRow` spends three lines on status, branch and provider; none of those
 * answer the question this row is here for, which is "where do I go to
 * coordinate". So it is a glyph, a word, and the rail's own hover and accent
 * grammar — shared with `DraftRow`, which is the part that has to match,
 * without sharing a component.
 */

import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import { hostPrefix } from "@/lib/hosts/client";

/** What the row says, and the only name this screen has. Spelled once so the
 *  rail, the page and the settings group cannot drift into three words. */
export const AGENT_LABEL = "Agent";

/**
 * WHERE THE ENTRY GOES — `/agent`, or the same address qualified by a Mac.
 *
 * A RESERVED ADDRESS FOR THE ROLE, NOT FOR AN ID: there is exactly one Agent
 * per machine and no session id to build a `/projects/<id>/sessions/<id>` URL
 * from. A person who bookmarks this wants "the Agent", and that outlives every
 * thread behind it — a reset mints a new one and this address does not move.
 *
 * IT CARRIES THE HOST like every other address in this rail. `hostPrefix` is
 * empty for the local engine, so the plain `/agent` is what a one-Mac cockpit
 * ever sees; a paired Mac's row addresses that Mac, because a bare `/agent`
 * would resolve against the LOCAL engine and open this cockpit's own Agent —
 * the right shape of screen, the wrong machine, with nothing on it saying so.
 */
export function agentHref(hostId?: string): string {
  return `${hostPrefix(hostId)}/agent`;
}

/**
 * WHETHER THE RAIL DRAWS THE ROW AT ALL — the whole gating rule, in one place
 * so it can be held to by a test rather than read off a component.
 *
 * `enabledByHost` IS WHAT EACH MAC SAID on the live read the rail was making
 * anyway, keyed by host id with `LOCAL_HOST_ID` for this one. A host that is
 * MISSING from the map has not answered yet (or is away), and a host that
 * answered `false` has the Agent switched off — both draw nothing, and both
 * should: the row is one the rail does not have until an engine says it does,
 * so a cockpit that never got a read in shows exactly the rail it always did.
 *
 * `viewedHost` IS THE ADDRESS BAR'S ANSWER (`hostFromPathname`), so this is a
 * pure function of two values a test can hand it.
 */
export function agentEntryShown(enabledByHost: ReadonlyMap<string, boolean>, viewedHost: string): boolean {
  return enabledByHost.get(viewedHost) === true;
}

/**
 * WHETHER THE ROW IS THE PAGE YOU ARE ON — `aria-current` and the accent.
 *
 * COMPARED AS A PATHNAME PREFIX rather than for equality, because `/agent` and
 * `/hosts/<id>/agent` are the only two shapes and neither takes a suffix today.
 * Equality would be enough now and would quietly stop being enough the first
 * time the screen grows a sub-route; a prefix is right for both.
 */
export function agentEntryActive(pathname: string, hostId?: string): boolean {
  const href = agentHref(hostId);
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AgentEntry({
  hostId,
  active,
  onNavigate,
}: {
  /** The Mac this row is about — the one the address bar names. `undefined`
   *  and `LOCAL_HOST_ID` both mean this cockpit's own engine. */
  hostId?: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <div className={`group/agent relative flex items-center rounded-md ${active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}>
      <Link
        href={agentHref(hostId)}
        onClick={onNavigate}
        {...(active ? { "aria-current": "page" as const } : {})}
        // py-1 is `slim`'s own padding, exactly as `DraftRow` takes it: this row
        // must never be taller than the conversations below it.
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SparklesIcon aria-hidden className="size-3 shrink-0 text-sidebar-foreground/50" />
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground">{AGENT_LABEL}</span>
      </Link>
    </div>
  );
}
