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
 * ── IT WAS ONE LINE, AND THAT WAS TOO QUIET (#539) ──────────────────────────
 * The row shipped deliberately no taller than a conversation below it: a glyph,
 * a word, `py-1` and `text-xs`, on the argument that it answers only "where do I
 * go to coordinate" and `SessionRow`'s three lines of status, branch and
 * provider answer questions it does not have.
 *
 * The owner's first night with it says the argument was half right. The BRANCH
 * and the PROVIDER are still questions this row does not have — there is no
 * checkout and no provider session. But "is it working, is it waiting for me"
 * is a question it very much has, and a row that could not answer it made the
 * one always-present entry in the rail the least informative thing in it.
 *
 * So it is a card-like row now: `py-2.5`, a `size-4` glyph, the label at
 * `text-sm`, and ONE status line under it — the same four facts a session row
 * shows in its badge slot (working, waiting, queued, or what the last turn
 * cost), with the rail's own spinner-for-moving and dot-for-parked grammar, so
 * a reader who has learned the list does not have to learn this row separately.
 *
 * WHERE THE STATUS COMES FROM is `lib/agent/status.ts`, and it is deliberately
 * NOT the live read the `enabled` flag rides: that route is conditional on the
 * sessions revision, which the Agent's own turns do not move, so a status folded
 * into it would freeze. The flag still decides whether the row exists; the row
 * asks for its own status once it does.
 */

import Link from "next/link";
import { CircleDashedIcon, CircleDotIcon, SparklesIcon } from "lucide-react";
import { hostPrefix, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { agentStatus, useAgentStatus } from "@/lib/agent/status";

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

/** The rail's own two tones for a row's status, by the vocabulary's rule:
 *  `--warning` for "a person has to move", `--primary` for a live turn. */
const STATUS_TONE = {
  waiting: "text-warning",
  working: "text-primary",
  idle: "text-sidebar-foreground/45",
} as const;

export function AgentEntry({
  hostId,
  active,
  onNavigate,
  status,
}: {
  /** The Mac this row is about — the one the address bar names. `undefined`
   *  and `LOCAL_HOST_ID` both mean this cockpit's own engine. */
  hostId?: string;
  active: boolean;
  onNavigate: () => void;
  /**
   * THE STATUS, INJECTED, so this component renders on the server and in a test
   * without a poll behind it. `AgentEntryLive` below is the one that asks; a
   * caller with the state already in hand passes it straight through.
   */
  status?: ReturnType<typeof agentStatus>;
}) {
  const line = status ?? agentStatus(undefined);
  return (
    <div className={`group/agent relative flex items-center rounded-md ${active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}>
      <Link
        href={agentHref(hostId)}
        onClick={onNavigate}
        {...(active ? { "aria-current": "page" as const } : {})}
        /* py-2.5 is the card-like height #539 asked for: this row is the one
           thing always in the rail, and it now answers a question rather than
           only pointing at a screen. It is deliberately the ONLY row that is
           taller than a conversation. */
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SparklesIcon aria-hidden className="size-4 shrink-0 text-sidebar-foreground/50" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate text-sm text-sidebar-foreground">{AGENT_LABEL}</span>
          <span className={`inline-flex min-w-0 items-center gap-1 text-2xs ${STATUS_TONE[line.tone]}`}>
            {/* THE RAIL'S OWN GRAMMAR, not a second one: a spinner means still
                going, a still dot means parked and waiting for a person. The
                motion is the fastest read in the list. */}
            {line.tone === "working" ? (
              <CircleDashedIcon aria-hidden className="size-3 shrink-0 animate-spin [animation-duration:3s]" />
            ) : line.tone === "waiting" ? (
              <CircleDotIcon aria-hidden className="size-3 shrink-0" />
            ) : null}
            {/* `role="status"` on the LABEL alone, as the session rows do. */}
            <span role="status" className="truncate">
              {line.label}
            </span>
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * The entry with its own status behind it — what the rail mounts.
 *
 * SPLIT FROM THE RENDER ABOVE so the hook is the only thing that needs a live
 * engine: the markup is a pure function of a status a test can hand it, and the
 * poll is one line here rather than something to mock.
 */
export function AgentEntryLive({ hostId, active, onNavigate }: { hostId?: string; active: boolean; onNavigate: () => void }) {
  const state = useAgentStatus(hostId ?? LOCAL_HOST_ID);
  return <AgentEntry {...(hostId ? { hostId } : {})} active={active} onNavigate={onNavigate} status={agentStatus(state)} />;
}
