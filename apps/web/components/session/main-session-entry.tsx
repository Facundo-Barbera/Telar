"use client";

/**
 * THE ONE CONVERSATION YOU COORDINATE FROM, above the bands and below Search —
 * experimental, and drawn only when this Mac has one switched on (#522).
 *
 * ABOVE EVERYTHING INCLUDING DRAFTS, because it is not a band and not an entry
 * in the list: it is the row that is always in the same place, which is the
 * whole of what designating a session buys. The bands under it are untouched,
 * and the conversation is still in its own project group down there — one row
 * at the top is not a promise the other one has gone.
 *
 * ONE LINE, LIKE A DRAFT AND FOR THE SAME REASON. `SessionRow` spends three on
 * status, branch and provider; none of those answer the question this row is
 * here for, which is "where do I go to coordinate". So it is a glyph, a title
 * and the rail's own hover and accent grammar — shared with `DraftRow`, which is
 * the part that has to match, without sharing a component.
 *
 * NOT A `SessionRow` VARIANT, on that component's own note: its body assumes a
 * row's activity and provider, and a third variant would mean threading "but not
 * this one" through every branch of it.
 *
 * WHERE IT GOES IS `sessionHref`'S ANSWER, NOT A STRING COMPOSED HERE. Since
 * #526 the minted coordinator has no project, and that function is what knows
 * such a session lives at the reserved `/main` rather than at a
 * `/projects/<id>/sessions/<id>` URL there is no id to build. A conversation
 * designated under #523 still has a project and still gets its own address —
 * one spelling, two honest answers.
 */

import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import type { MainSession } from "@telar/engine-client";
import { sessionHref, type SidebarSession } from "@/lib/session-list";

/**
 * WHICH ROW THE ENTRY DRAWS, or none — the whole gating rule, in one place so
 * it can be held to rather than read off a component.
 *
 * ABSENT COVERS EVERY HONEST CASE AT ONCE: the feature is off, nothing is
 * designated, the engine is older than the field, the first read has not landed,
 * or the designated conversation is not in the rows this rail holds. All of them
 * should draw the rail Telar always drew.
 *
 * LOCAL ROWS ONLY. `hostId` is undefined for this Mac's own sessions; a paired
 * Mac may designate a coordinator of its own, and that one is not the
 * conversation THIS cockpit coordinates from. Its row stays in its project group
 * exactly where it was.
 */
export function mainSessionRow(sessions: readonly SidebarSession[], main: MainSession | undefined): SidebarSession | undefined {
  if (!main?.enabled || !main.sessionId) return undefined;
  return sessions.find((session) => session.id === main.sessionId && session.hostId === undefined);
}

export function MainSessionEntry({
  session,
  active,
  onNavigate,
}: {
  session: SidebarSession;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <div className={`group/main relative flex items-center rounded-md ${active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/70"}`}>
      <Link
        href={sessionHref(session)}
        onClick={onNavigate}
        {...(active ? { "aria-current": "page" as const } : {})}
        // py-1 is `slim`'s own padding, exactly as `DraftRow` takes it: this row
        // must never be taller than the conversations below it.
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SparklesIcon aria-hidden className="size-3 shrink-0 text-sidebar-foreground/50" />
        {/* THE WORD THE GLYPH STANDS IN FOR, for a reader who is not looking at
            it — `DraftRow`'s treatment of its pencil, and for the same reason:
            there is no band heading above this to carry the noun. */}
        <span className="sr-only">Main session: </span>
        {/* A TITLE THE PERSON GAVE IT, or the word itself. Never the id: a row
            reading `session_8f3a…` at the top of the rail is worse than one
            reading "Main", and the id is not what anybody called it. */}
        <span className="min-w-0 flex-1 truncate text-xs text-sidebar-foreground">{session.title || "Main"}</span>
      </Link>
    </div>
  );
}
