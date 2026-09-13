"use client";

/**
 * WHO IS WORKING FOR THIS CONVERSATION, AND WHO IT IS WORKING FOR — issue #381.
 *
 * The rail used to say this with an indent: a session somebody had handed work
 * to was drawn as a child row under the one that handed it over. The owner's
 * objection is the right one — "it makes it feel like sub-agents when they are
 * really separate conversations" — and an indent cannot be argued with. It has
 * no room to say WHICH errand, how it went, or when; it just puts one row under
 * another and leaves the reader to guess what that means.
 *
 * A section can say all of it. So the relationship moved here, to the panel
 * surface that already holds "what is working on this" — and gained the three
 * facts the elbow could never carry: the scope the coordinator named, the
 * outcome the errand reached, and when.
 *
 * TWO DIRECTIONS, BECAUSE THEY ARE TWO QUESTIONS. "Working for this
 * conversation" is the coordinator's view and is usually several rows; "Working
 * for" is the delegate's own, and a session that was handed a task has exactly
 * one interesting fact about it. A surface that showed only the first would be
 * silent in the conversation most likely to be read by somebody wondering why
 * it exists.
 *
 * THE SAME TWO READS THE TREE MADE. `assignments` rides the live list, which
 * the engine folds over every queue, and subscriptions are one route per
 * session. Nothing here is a per-row history read.
 *
 * FOUR RELATIONSHIPS, STILL NOT MERGED:
 *
 *   assigned    outstanding work on this conversation's behalf; it ENDS
 *   finished    the errand is over — the result this conversation delegated for
 *   started     started from here; permanent, and ends nothing
 *   followed    a revocable wish to be woken, and nothing more
 *
 * None confers permission and none is a lifetime. Rows link through
 * `sessionHref`, which carries the host prefix — two Macs can mint one id.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, BellIcon, BellOffIcon, UsersIcon } from "lucide-react";
import type { SessionAssignment, Subscription } from "@telar/engine-client";
import { PanelEmpty, PanelRow, type PanelTone } from "@/components/ui/panel";
import { createEngineApi } from "@/lib/engine/client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { hostFetcher } from "@/lib/hosts/client";
import { createFollowingController, lockKey, type FollowingController } from "@/lib/following";
import { fmtAgo } from "@/lib/format";
import { activityBadge } from "@/lib/session-activity";
import { relatedWork, sessionHref, sessionKey, toSidebarSession, type SidebarSession } from "@/lib/session-list";
import { cn } from "@/lib/utils";

type Outcome = NonNullable<SessionAssignment["outcome"]>;

/** How a conversation is related to the one being read. The order is the order
 *  the rows are drawn in, and it is the order the tree sorted in too. */
export type RelationKind = "assigned" | "finished" | "started" | "followed";

export type Delegate = {
  session: SidebarSession;
  kind: RelationKind;
  /** What the coordinator said the errand covers. Descriptive; confers nothing. */
  scope?: string;
  outcome?: Outcome;
  /** When the relationship was last stamped — handed over, ended, or started. */
  at?: number;
  /**
   * EVERY subscription this conversation holds on the row, which is what an
   * unfollow has to remove: a target can be followed twice (two events, or a
   * `once` beside a standing one) and removing one would leave the row followed
   * while the control said otherwise. Empty on a row nobody is watching.
   */
  subscriptionIds: string[];
};

/** An errand this conversation was handed, and who handed it over. */
export type Employer = {
  /** The coordinator's own row, when the list still holds it. A coordinator
   *  that has been archived is absent — `liveSessions` carries no archived
   *  rows — and the row then names it by id rather than by nothing. */
  session?: SidebarSession;
  sessionId: string;
  scope?: string;
  outcome?: Outcome;
  /** Handed over at, or ended at once it has. */
  at: number;
  /** Outstanding, and not merely un-ended: an `unresolved` assignment's carrier
   *  is gone, so its state is unknown rather than live (protocol/assignments). */
  outstanding: boolean;
  unresolved: boolean;
};

/** The outstanding errand from one coordinator — not the first historical one
 *  that happened to carry a scope, which would show a row the words of a task
 *  it finished last week. */
const outstandingFrom = (assignments: readonly SessionAssignment[] | undefined, coordinatorId: string) =>
  assignments?.find((a) => a.fromSessionId === coordinatorId && a.outcome === undefined && !a.unresolved);

/** The most recent ENDED errand from one coordinator. `assignments` is newest
 *  last, so the last match is the one the row is reporting. */
const endedFrom = (assignments: readonly SessionAssignment[] | undefined, coordinatorId: string) =>
  assignments?.filter((a) => a.fromSessionId === coordinatorId && a.outcome !== undefined && a.outcome !== "detached").at(-1);

/**
 * WHICH SESSIONS THIS ONE IS WATCHING, as `key → subscription ids`.
 *
 * HOST-QUALIFIED, AND DEDUPLICATED. A subscription's `targetSessionId` is a
 * bare id, so matching on id alone can select a same-id session from another
 * Mac; this conversation's own host is the frame.
 */
function watched(
  rows: readonly SidebarSession[],
  following: readonly Subscription[],
  hostId: string | undefined,
): Map<string, { session: SidebarSession; subscriptionIds: string[] }> {
  const found = new Map<string, { session: SidebarSession; subscriptionIds: string[] }>();
  for (const subscription of following) {
    const match = rows.find(
      (candidate) => candidate.id === subscription.targetSessionId && (candidate.hostId ?? undefined) === (hostId ?? undefined),
    );
    if (!match) continue;
    const key = sessionKey(match);
    const entry = found.get(key);
    if (entry) entry.subscriptionIds.push(subscription.id);
    else found.set(key, { session: match, subscriptionIds: [subscription.id] });
  }
  return found;
}

/**
 * The conversations working for this one.
 *
 * ONE ROW PER CONVERSATION, whatever else is true of it. A session that is
 * running an errand AND is followed is one relationship to a reader and two
 * facts about it; the strongest relationship names the row and the subscription
 * rides along, which is what keeps the unfollow control on the row it belongs
 * to rather than on a duplicate underneath.
 */
export function delegatesOf(
  rows: readonly SidebarSession[],
  coordinator: Pick<SidebarSession, "id" | "hostId">,
  following: readonly Subscription[] = [],
): Delegate[] {
  const related = relatedWork(rows, coordinator);
  const follows = watched(rows, following, coordinator.hostId);
  const out: Delegate[] = [];
  const seen = new Set<string>();
  const add = (session: SidebarSession, entry: Omit<Delegate, "session" | "subscriptionIds">) => {
    const key = sessionKey(session);
    if (seen.has(key) || key === sessionKey(coordinator)) return;
    seen.add(key);
    out.push({ session, ...entry, subscriptionIds: follows.get(key)?.subscriptionIds ?? [] });
  };

  for (const session of related.active) {
    const errand = outstandingFrom(session.assignments, coordinator.id);
    add(session, {
      kind: "assigned",
      ...(errand?.scope ? { scope: errand.scope } : {}),
      ...(errand ? { at: errand.receivedAt } : {}),
    });
  }
  for (const session of related.review) {
    const errand = endedFrom(session.assignments, coordinator.id);
    add(session, {
      kind: "finished",
      ...(errand?.scope ? { scope: errand.scope } : {}),
      ...(errand?.outcome ? { outcome: errand.outcome } : {}),
      ...(errand?.endedAt === undefined ? {} : { at: errand.endedAt }),
    });
  }
  for (const session of related.independent) add(session, { kind: "started", at: session.createdAt });
  for (const [, { session }] of follows) add(session, { kind: "followed" });
  return out;
}

/**
 * The conversations this one is working for — the inverse, and the whole of it:
 * `assignments` is exactly "who handed me work", engine-stamped.
 *
 * OUTSTANDING FIRST, then the finished ones newest-first. A detached errand is
 * dropped: "continue independently" is the reader saying this is nobody's work
 * any more, and listing it under "Working for" would be the panel disagreeing.
 */
export function coordinatorsOf(rows: readonly SidebarSession[], session: SidebarSession): Employer[] {
  const host = session.hostId;
  const found: Employer[] = [];
  for (const assignment of session.assignments ?? []) {
    if (assignment.outcome === "detached") continue;
    const match = rows.find(
      (candidate) => candidate.id === assignment.fromSessionId && (candidate.hostId ?? undefined) === (host ?? undefined),
    );
    found.push({
      ...(match ? { session: match } : {}),
      sessionId: assignment.fromSessionId,
      ...(assignment.scope ? { scope: assignment.scope } : {}),
      ...(assignment.outcome ? { outcome: assignment.outcome } : {}),
      at: assignment.endedAt ?? assignment.receivedAt,
      outstanding: assignment.outcome === undefined && !assignment.unresolved,
      unresolved: assignment.unresolved === true,
    });
  }
  return found.sort((a, b) => Number(b.outstanding) - Number(a.outstanding) || b.at - a.at);
}

// ── presentation ───────────────────────────────────────────────────────────

const OUTCOME: Record<Outcome, string> = {
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
  detached: "Detached",
};

const OUTCOME_TONE: Record<Outcome, PanelTone> = {
  completed: "done",
  failed: "danger",
  stopped: "none",
  detached: "none",
};

/**
 * WHAT A DELEGATE ROW REPORTS, and in which register.
 *
 * A LIVE ROW REPORTS ITS OWN ACTIVITY; a finished one reports the OUTCOME. They
 * are different facts and the row has one trailing word, so the choice matters:
 * "Done" on a session that has since started something else would be the panel
 * describing the errand while the reader is looking at the conversation, and
 * "Idle" on a delegate whose result is waiting would be the reverse.
 */
function delegateState(entry: Delegate): { label: string; tone: PanelTone } {
  if (entry.kind === "finished" && entry.outcome) return { label: OUTCOME[entry.outcome], tone: OUTCOME_TONE[entry.outcome] };
  const badge = activityBadge(entry.session.activity);
  if (!badge) return { label: entry.kind === "assigned" ? "Working" : "Idle", tone: "none" };
  return { label: badge.label, tone: badge.tone === "attention" ? "attention" : badge.tone === "live" ? "active" : "none" };
}

/** The second line: which errand, and when. Absent where there is neither. */
function detailOf(entry: Delegate, now: number): string | undefined {
  const parts: string[] = [];
  if (entry.scope) parts.push(entry.scope);
  else if (entry.kind === "started") parts.push("started from here");
  else if (entry.kind === "followed") parts.push("following");
  if (entry.at !== undefined) parts.push(fmtAgo(entry.at, now));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * ONE ROW: what the conversation is called, what it is doing, and a way in.
 *
 * THE CONTROL IS A SIBLING OF THE LINK, NEVER INSIDE IT — a button nested in an
 * anchor is neither, and this row's whole surface is a link.
 */
function Row({
  href,
  title,
  detail,
  state,
  tone,
  action,
}: {
  href: string;
  title: string;
  detail?: string;
  state?: string;
  tone: PanelTone;
  action?: React.ReactNode;
}) {
  return (
    <PanelRow tone={tone} className="group/row gap-1.5 p-0 pl-0">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-4 hover:bg-muted/60">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs">{title}</span>
          {detail && <span className="truncate text-[0.625rem] text-muted-foreground">{detail}</span>}
        </span>
        {state && (
          <span className={cn("shrink-0 font-mono text-[0.625rem]", tone === "danger" ? "text-destructive" : "text-muted-foreground")}>
            {state}
          </span>
        )}
        <ArrowUpRightIcon className="size-3 shrink-0 opacity-40" aria-hidden />
      </Link>
      {action && <span className="shrink-0 pr-2">{action}</span>}
    </PanelRow>
  );
}

/** A section heading in the panel's own register — the machine naming a region
 *  of the record, never a sentence addressed to the reader. */
function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 font-mono text-[0.625rem] tracking-[0.08em] text-muted-foreground uppercase">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>
    </div>
  );
}

/** What the panel holds while it reads, and what it says when it could not. */
type Read = {
  rows: SidebarSession[];
  following: Subscription[];
  failed: boolean;
  done: boolean;
  /**
   * WHEN THIS ANSWER WAS READ, which is the clock every "3m ago" on the surface
   * is measured against. Taken here rather than at render: `Date.now()` in a
   * render body is impure, and a relative time recomputed on an unrelated
   * re-render would tick at whatever rate React happened to paint at.
   */
  at: number;
};

const EMPTY_READ: Read = { rows: [], following: [], failed: false, done: false, at: 0 };

/**
 * THE TWO READS, on the same clock as the surface around them.
 *
 * `liveSessions` is the pool — the one route that carries `assignments`, folded
 * by the engine over every queue — and `subscriptions` is this conversation's
 * own. Both go to the Mac the conversation lives on, so reading a remote
 * cockpit never asks the local engine about a remote session.
 *
 * POLLED, BECAUSE A DELEGATE'S STATE IS NOT THIS SESSION'S EVENT. A worker
 * finishing an errand writes nothing to the journal this panel is mounted
 * beside, so a surface that only re-read on its own turn boundary would show a
 * running delegate forever.
 */
function useRelated(sessionId: string | undefined, hostId: string | undefined, visible: boolean, nudge: number): Read {
  const [read, setRead] = useState<Read>(EMPTY_READ);
  useEffect(() => {
    if (!sessionId || !visible) return;
    let live = true;
    const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
    const tick = async () => {
      const [list, subscriptions] = await Promise.all([
        api.liveSessions().then((value) => value, () => undefined),
        api.sessionSubscriptions(sessionId).then((value) => value.subscriptions, () => undefined),
      ]);
      if (!live) return;
      setRead((current) => ({
        // A FAILED READ PRESERVES THE LAST GOOD ANSWER. An empty list claims
        // nobody is working here, and a dropped request is not evidence of that.
        rows: list
          ? list.sessions.map((session) => ({
              ...toSidebarSession(session, undefined, undefined, undefined, undefined, list.assignments?.[session.id]),
              ...(hostId ? { hostId } : {}),
            }))
          : current.rows,
        following: subscriptions ? [...subscriptions] : current.following,
        failed: list === undefined,
        done: true,
        at: Date.now(),
      }));
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // `nudge` is a request to come round NOW — a follow just changed the answer
    // and ten seconds of a stale control is ten seconds of the panel arguing
    // with a button the reader pressed.
  }, [sessionId, hostId, visible, nudge]);
  return read;
}

export function RelatedConversations({
  sessionId,
  hostId,
  /** False while the panel is behind another tab — nothing polls off screen. */
  visible = true,
}: {
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
}) {
  const [nudge, setNudge] = useState(0);
  const read = useRelated(sessionId, hostId, visible, nudge);
  /**
   * Owns the sync locks and the read epoch, outside React — a `useState`
   * updater is not a lock (React does not promise to run it before the next
   * event, and StrictMode invokes it twice). Its own published state is
   * discarded: this surface re-reads rather than patching a second copy.
   */
  const [follow] = useState<FollowingController>(() => createFollowingController(() => {}));
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  /** Memoised because `toggle` closes over it: a fresh object per render would
   *  rebuild the callback on every poll, for a value that never changes. */
  const coordinator = useMemo<Pick<SidebarSession, "id" | "hostId"> | undefined>(
    () => (sessionId ? { id: sessionId, ...(hostId ? { hostId } : {}) } : undefined),
    [sessionId, hostId],
  );

  /**
   * FOLLOW AND UNFOLLOW, through the controller that already owns the locks and
   * the failure states — `lib/following.ts`, which the rail used before the tree
   * it hung on was removed. Every bug it replaced was a state bug: a removal
   * claimed on a failed request, an empty list asserted from one.
   *
   * THE LIST IS RE-READ RATHER THAN PATCHED. This surface polls; a local edit
   * would be a second copy of the answer that the next tick overwrites anyway.
   */
  const toggle = useCallback(
    async (entry: Delegate) => {
      if (!coordinator || !sessionId) return;
      const targetKey = sessionKey(entry.session);
      const lock = lockKey(hostId, sessionId, targetKey);
      if (follow.locked(lock)) return;
      setBusy((current) => new Set(current).add(lock));
      const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
      const self = { id: sessionId, ...(hostId ? { hostId } : {}), key: sessionKey(coordinator) };
      const outcome =
        entry.subscriptionIds.length > 0
          ? await follow.unfollow(self, targetKey, entry.subscriptionIds, async (_session, subscriptionId) => {
              await api.unfollow(subscriptionId, sessionId);
            })
          : await follow.follow(
              self,
              { id: entry.session.id, key: targetKey },
              async (_session, targetSessionId) => void (await api.follow(sessionId, { targetSessionId })),
              async () => (await api.sessionSubscriptions(sessionId)).subscriptions,
            );
      setFailed((current) => {
        const next = new Set(current);
        if (outcome.failed) next.add(lock);
        else next.delete(lock);
        return next;
      });
      setBusy((current) => {
        const next = new Set(current);
        next.delete(lock);
        return next;
      });
      // Ask the poll to come round now rather than in ten seconds.
      setNudge((current) => current + 1);
    },
    [coordinator, follow, hostId, sessionId],
  );

  if (!sessionId || !coordinator) return null;

  const self = read.rows.find((row) => sessionKey(row) === sessionKey(coordinator));
  return (
    <RelatedConversationsView
      delegates={delegatesOf(read.rows, coordinator, read.following)}
      employers={self ? coordinatorsOf(read.rows, self) : []}
      lockFor={(targetKey) => lockKey(hostId, sessionId, targetKey)}
      onToggleFollow={(entry) => void toggle(entry)}
      busy={busy}
      failed={failed}
      read={read.done ? (read.failed ? "failed" : "done") : "reading"}
      now={read.at}
    />
  );
}

/**
 * THE SECTIONS THEMSELVES, given their answers rather than fetching them.
 *
 * Split from the component above for the reason every derivation in this file
 * is exported: what a row SAYS — which state word, which outcome, whether the
 * control offers to follow or to stop — is a decision, and a decision made
 * inside a component that owns two network reads is one nothing can put a case
 * to without a server.
 */
export function RelatedConversationsView({
  delegates,
  employers,
  lockFor,
  onToggleFollow,
  busy,
  failed,
  read = "done",
  now,
}: {
  delegates: readonly Delegate[];
  employers: readonly Employer[];
  /** The lock id for a row — this conversation AND the target, not the target
   *  alone, so one row's request never blocks another's. */
  lockFor?: (targetKey: string) => string;
  onToggleFollow?: (entry: Delegate) => void;
  busy?: ReadonlySet<string>;
  failed?: ReadonlySet<string>;
  read?: "reading" | "done" | "failed";
  /** WHEN THE ANSWER WAS READ — every "3m ago" below is measured against it.
   *  Passed in rather than taken here: a render body may not call `Date.now`. */
  now: number;
}) {
  const stamp = now;

  if (delegates.length === 0 && employers.length === 0) {
    // NOTHING AT ALL UNTIL THE FIRST ANSWER. "No other conversation is
    // involved" before the read lands is a claim made from silence, and on a
    // coordinator it is the wrong one.
    if (read === "reading") return null;
    return (
      <PanelEmpty icon={<UsersIcon />} title="No other conversation is involved">
        {read === "failed"
          ? "The engine did not answer — retrying."
          : "Conversations this one hands work to appear here, with what they were asked for and how it went."}
      </PanelEmpty>
    );
  }

  return (
    <div className="flex flex-col">
      {delegates.length > 0 && (
        <>
          <SectionLabel label="Working for this conversation" count={delegates.length} />
          {delegates.map((entry) => {
            const key = sessionKey(entry.session);
            const lock = lockFor?.(key) ?? key;
            const state = delegateState(entry);
            const pending = busy?.has(lock) ?? false;
            const broke = failed?.has(lock) ?? false;
            const followed = entry.subscriptionIds.length > 0;
            return (
              <Row
                key={key}
                href={sessionHref(entry.session)}
                title={entry.session.title || "Untitled session"}
                {...(detailOf(entry, stamp) ? { detail: detailOf(entry, stamp) } : {})}
                state={state.label}
                tone={state.tone}
                {...(onToggleFollow
                  ? {
                      action: (
                        <button
                          type="button"
                          // The row is still followed until the engine says
                          // otherwise, so a failed attempt offers a retry
                          // rather than vanishing.
                          aria-label={`${broke ? "Retry " : ""}${followed ? "Stop following" : "Follow"} ${entry.session.title}`}
                          title={
                            broke
                              ? "That did not go through — try again"
                              : followed
                                ? "Stop following"
                                : "Follow — be woken when it finishes"
                          }
                          disabled={pending}
                          onClick={() => onToggleFollow(entry)}
                          className={cn(
                            "rounded p-1 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/row:opacity-70 disabled:opacity-40",
                            broke && "text-destructive opacity-70",
                          )}
                        >
                          {followed ? <BellOffIcon className="size-3.5" aria-hidden /> : <BellIcon className="size-3.5" aria-hidden />}
                        </button>
                      ),
                    }
                  : {})}
              />
            );
          })}
        </>
      )}

      {employers.length > 0 && (
        <>
          {/* THE INVERSE, AND IT IS NOT A MIRROR. A delegate has one thing to
              say — who asked, for what, and whether it is still owed — and the
              row that names it is the coordinator, not this conversation. */}
          <SectionLabel label="Working for" count={employers.length} />
          {employers.map((entry, index) => {
            const title = entry.session?.title || `Conversation ${entry.sessionId.slice(0, 8)}`;
            const detail = [entry.scope, entry.unresolved ? "state unknown" : undefined, fmtAgo(entry.at, stamp)]
              .filter(Boolean)
              .join(" · ");
            const state = entry.outcome ? OUTCOME[entry.outcome] : entry.unresolved ? "Unknown" : "Working for";
            const tone: PanelTone = entry.outcome ? OUTCOME_TONE[entry.outcome] : entry.outstanding ? "active" : "none";
            return entry.session ? (
              <Row
                key={`${entry.sessionId}:${entry.at}:${index}`}
                href={sessionHref(entry.session)}
                title={title}
                detail={detail}
                state={state}
                tone={tone}
              />
            ) : (
              /* NO LINK WITHOUT A ROW. The coordinator has been archived — the
                 live list does not carry it — and a link built from a bare id
                 would 404 in a way that reads as a routing bug. */
              <PanelRow key={`${entry.sessionId}:${entry.at}:${index}`} tone={tone} className="gap-1.5 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs text-muted-foreground">{title}</span>
                  <span className="truncate text-[0.625rem] text-muted-foreground">{[detail, "no longer listed"].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">{state}</span>
              </PanelRow>
            );
          })}
        </>
      )}
    </div>
  );
}
