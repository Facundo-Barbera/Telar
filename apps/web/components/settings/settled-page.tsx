"use client";

/**
 * WHAT IS OFF YOUR LIST, AND THE WAY BACK.
 *
 * The rail bands settled conversations behind a collapsed "Settled (65)" and
 * that is the only place they exist. Two things are wrong with that being the
 * only place: the band lives under whatever the rail is currently filtered and
 * grouped by, so a settled conversation in a folded project group is two
 * gestures from being seen at all — and there is no surface that answers "what
 * has this cockpit quietly put away", which is the question somebody asks when
 * a conversation they remember is not where they left it.
 *
 * THE REFERENCE CALLS THIS ARCHIVE; TELAR DOES NOT, AND THE DIFFERENCE IS THE
 * POINT. The survey's own "do not adopt" list is right that Telar removed
 * archive-as-a-lifecycle on purpose: archive was the irreversible verb that
 * looked reversible. Settling is the reversible one, and this pane is the shape
 * of that promise — every row carries the undo, because a shelf you cannot take
 * things off is a bin.
 *
 * SETTLED IS DERIVED, NOT STORED, so this pane cannot ask the engine for "the
 * settled ones". `isSettled` is the same three-layer rule the rail bands by
 * (lib/session-settling.ts) and it reads a pin, a snooze, an unread answer and
 * the clock — so the pane runs it over the live list with the same inbox policy
 * the rail uses. Which means a row here is settled for one of two quite
 * different reasons, and the row says which: somebody settled it, or it went
 * quiet for longer than the window.
 *
 * RESTORE IS THE RAIL'S OWN RESTORE, not a second opinion about the word. The
 * row's ⋯ menu already has this verb and it is two patches rather than one for
 * a reason `session-row.tsx` states: see `restore` below.
 */

import { useCallback, useEffect, useState } from "react";
import { ArchiveIcon, ExternalLinkIcon, Undo2Icon } from "lucide-react";
import type { Session } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { fmtAgo } from "@/lib/format";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { SETTLED_PAGE_SIZE, sessionHref, settlingActivity, toSidebarSession, type SidebarSession } from "@/lib/session-list";
import { isSettled } from "@/lib/session-settling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

export type SettledRow = {
  session: SidebarSession;
  /** Somebody settled this one by hand, rather than the clock doing it. A
   *  reader who is looking for something they did not put away needs to be
   *  able to tell the two apart at a glance. */
  byHand: boolean;
};

/**
 * The settled ones, newest first.
 *
 * PURE, AND TAKING `now`, so every branch of the rule this depends on can be
 * tested without a clock or a network — including the one that matters most
 * here, that a session waiting on a human is never settled however it was
 * pinned.
 */
export function settledRows(
  sessions: readonly Session[],
  projects: readonly { id: string; name: string }[],
  options: { now: number; autoSettleAfterHours: number | null },
): SettledRow[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return sessions
    .map((session) => toSidebarSession(session, session.projectId ? names.get(session.projectId) : undefined))
    .filter((session) => isSettled(session, settlingActivity(session), options))
    .map((session) => ({ session, byHand: session.settledOverride === "settled" }))
    .sort((left, right) => (right.session.settledAt ?? right.session.updatedAt) - (left.session.settledAt ?? left.session.updatedAt));
}

export function SettledPage() {
  const { policy } = useInboxPolicy();
  const [sessions, setSessions] = useState<Session[]>();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  /**
   * WHEN THE LIST WAS READ, and the instant the clock rule is evaluated at.
   *
   * Not `Date.now()` at render — which this app's lint forbids, and rightly:
   * the shelf is a fold over a list that arrived at one moment, so a clock that
   * advanced between two renders would move a row across the boundary while
   * nothing about it had changed.
   */
  const [readAt, setReadAt] = useState<number>();
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  /** How many rows are shown. The shelf is history and months of it
   *  accumulate; the first page answers "what did I just finish". */
  const [shown, setShown] = useState(SETTLED_PAGE_SIZE);

  const load = useCallback(async () => {
    try {
      const answer = await api.liveSessions();
      setSessions(answer.sessions);
      setProjects(answer.projects);
      setReadAt(Date.now());
      setUnreachable(false);
    } catch {
      setSessions([]);
      setReadAt(Date.now());
      setUnreachable(true);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  /**
   * THE SAME TWO PATCHES THE RAIL'S OWN BUTTON MAKES (`session-row.tsx`), and
   * deliberately not a second opinion about what "restore" means.
   *
   * A session shelved by the CLOCK has no override to clear, and clearing
   * nothing writes nothing — so the row would come back and be re-shelved by
   * the same clock on the next render. Setting an override first makes the
   * clearing patch a real change, and a real change stamps `updatedAt`, which
   * is what actually restarts the inactivity window.
   */
  const restore = async (row: SettledRow) => {
    setBusy(row.session.id);
    setError(undefined);
    try {
      if (!row.byHand) await api.updateSession(row.session.id, { settledOverride: "active" });
      const { session } = await api.updateSession(row.session.id, { settledOverride: null });
      // THE ENGINE'S ANSWER IS THE STATE, as everywhere else here: the row
      // leaves the list because the record that came back is no longer
      // settled, not because the button was pressed.
      setSessions((current) => current?.map((entry) => (entry.id === session.id ? session : entry)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The engine refused to restore that conversation.");
    } finally {
      setBusy(undefined);
    }
  };

  const rows =
    sessions === undefined || readAt === undefined
      ? undefined
      : settledRows(sessions, projects, { now: readAt, autoSettleAfterHours: policy.autoSettleAfterHours });

  return (
    <SettingsGroup
      title="Settled sessions"
      // ONE SENTENCE (#357). The second — that restoring pins a conversation
      // back whatever the settling window says — is what the Restore button on
      // every row does, read before there is a row to press it on.
      description="Off your list, not finished."
      {...(rows && rows.length > 0 ? { action: <span className="text-xs tabular-nums text-muted-foreground">{rows.length} settled</span> } : {})}
    >
      {rows === undefined && <Row label="Reading the list" icon={ArchiveIcon} control={<Spinner />} />}

      {/* THE EMPTY STATE IS AN ORDINARY ROW in the ordinary card — icon, title,
          one sentence — so it occupies the shape the populated state will. No
          illustration, no centred hero. */}
      {rows?.length === 0 && (
        <Row
          label={unreachable ? "Nothing answered" : "Nothing is settled"}
          icon={ArchiveIcon}
          hint={
            unreachable
              ? "The engine is not answering, so this is not a claim that your shelf is empty."
              : "Conversations you settle, and ones that go quiet for longer than the window, land here."
          }
          {...(error ? { error } : {})}
        />
      )}

      {rows?.slice(0, shown).map(({ session, byHand }) => (
        <Row
          // The title is a value, so the anchor is stated rather than derived —
          // a search index must never point at an id that moves with data.
          key={session.id}
          id={`settings-row-settled-${session.id}`}
          label={session.title}
          icon={ArchiveIcon}
          // Dated against the same read the banding used, so the age and the
          // reason a row is here cannot be measured from two different clocks.
          hint={`${session.projectName ?? "No project"} · ${byHand ? "settled" : "quiet"} ${fmtAgo(session.settledAt ?? session.updatedAt, readAt)}`}
          {...(busy === session.id ? { status: <Badge variant="outline">Restoring</Badge> } : {})}
          {...(error && busy === undefined ? { error } : {})}
          control={
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" render={<a href={sessionHref(session)} />} aria-label={`Open ${session.title}`}>
                <ExternalLinkIcon className="size-3.5" />
                Open
              </Button>
              <Button variant="outline" size="sm" disabled={busy === session.id} onClick={() => void restore({ session, byHand })}>
                <Undo2Icon className="size-3.5" />
                Restore
              </Button>
            </div>
          }
        />
      ))}

      {rows && rows.length > shown && (
        <Row
          label={`${rows.length - shown} more`}
          icon={ArchiveIcon}
          hint="The shelf is history — months of it accumulate."
          control={
            <Button variant="outline" size="sm" onClick={() => setShown((current) => current + SETTLED_PAGE_SIZE)}>
              Show more
            </Button>
          }
        />
      )}
    </SettingsGroup>
  );
}
