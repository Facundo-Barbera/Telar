"use client";

/**
 * RELATED WORK — the conversations that hang off this one, drawn as its
 * children.
 *
 *   assignments   current work on this session's behalf; they END
 *   review        finished, not settled — still here so a delegated result is
 *                 not hidden the moment its run ended
 *   provenance    started from here; permanent, and ends nothing
 *   following     a revocable wish to be woken, and nothing more
 *
 * FOUR RELATIONSHIPS, ONE SHAPE, NO CAPTIONS — issue #323. Each used to carry a
 * title of its own, and in the pinned band that put a heading BETWEEN a
 * coordinator and the row it owned: with nothing indented, "FOLLOWING" read as a
 * header for the next pinned row instead of as a label on the one above. The
 * relationships still differ and they still sort in this order, but what the
 * rail has to say about a child row is "this comes from the row above" — which
 * an elbow says in a glyph's width, in every group at once, and a heading could
 * not say at all.
 *
 * THE BELL WENT WITH THEM. It was a state icon on rows whose state was the one
 * thing the block already guaranteed — every row under "Following" was
 * followed — so the glyph column now carries the elbow and the state that still
 * differs per row ("working", "finished") rides a small trailing hint.
 *
 * None confers permission and none is a lifetime. Rows link through
 * `sessionHref`, which carries the host prefix — two Macs can mint one id.
 */
import Link from "next/link";
import { ArrowUpRightIcon, BellIcon, BellOffIcon, CornerDownRightIcon } from "lucide-react";
import type { SessionAssignment, Subscription } from "@telar/engine-client";
import {
  localSettling,
  relatedWork,
  sessionHref,
  sessionKey,
  settledRow,
  type RelatedWork as RelatedWorkGroups,
  type RelatedWorkOptions,
  type SidebarSession,
} from "@/lib/session-list";
import { Badge } from "@/components/ui/badge";

/**
 * ONE CHILD ROW: the elbow, what the session is called, and how to get to it.
 *
 * THE ELBOW OCCUPIES THE INDENT, WHICH IS WHAT MAKES THE TITLES LINE UP.
 * `size-3.5` plus `gap-2` is exactly the slim row's own avatar plus its gap, so
 * a child's title lands in the same column as the title of the row it hangs off
 * and the tree reads against one ruler rather than two.
 *
 * THE ACTION IS A SIBLING OF THE LINK, NEVER INSIDE IT — a button nested in an
 * anchor is neither, and this row's whole surface is a link.
 */
function Row({
  session,
  hint,
  action,
}: {
  session: SidebarSession;
  /** The state that still differs per row. Absent where the row has none. */
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="group/row flex items-center">
      <Link
        href={sessionHref(session)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
      >
        <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{session.title}</span>
        {session.hostName && (
          <Badge variant="outline" className="shrink-0 text-[0.625rem]">
            {session.hostName}
          </Badge>
        )}
        {hint && <span className="ml-auto shrink-0 truncate text-muted-foreground">{hint}</span>}
        <ArrowUpRightIcon className="size-3 shrink-0 opacity-40" aria-hidden />
      </Link>
      {action}
    </div>
  );
}

/**
 * The scope of the assignment that is ACTUALLY OUTSTANDING — not the first
 * historical one that happened to carry a scope, which would show a row the
 * words of a task it finished last week.
 */
const scopeOf = (assignments: readonly SessionAssignment[] | undefined, coordinatorId: string): string | undefined =>
  assignments?.find(
    (assignment) =>
      assignment.fromSessionId === coordinatorId &&
      assignment.outcome === undefined &&
      !assignment.unresolved &&
      assignment.scope,
  )?.scope;

/** Offer Follow, unless this session is already followed. */
function followButton(
  session: SidebarSession,
  followedKeys: ReadonlySet<string>,
  onFollow?: (target: SidebarSession) => void,
  lock?: string,
  pending?: ReadonlySet<string>,
  failed?: ReadonlySet<string>,
): React.ReactNode {
  if (!onFollow || followedKeys.has(sessionKey(session))) return null;
  const busy = lock !== undefined && (pending?.has(lock) ?? false);
  const didFail = lock !== undefined && (failed?.has(lock) ?? false);
  return (
    <button
      type="button"
      aria-label={`${didFail ? "Retry follow" : "Follow"} ${session.title}`}
      title={didFail ? "Could not follow — try again" : "Follow — be woken when it finishes"}
      disabled={busy}
      onClick={() => onFollow(session)}
      className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover/row:opacity-70 disabled:opacity-40"
    >
      <BellIcon className="size-3.5" aria-hidden />
    </button>
  );
}

/**
 * WHICH ROWS THE FOLLOWED CHILDREN ACTUALLY ARE, as `{ session, subscriptionIds }`.
 *
 * HOST-QUALIFIED, AND DEDUPLICATED. A subscription's `targetSessionId` is a
 * bare id, so matching on id alone can select a same-id session from another
 * Mac; the coordinator's own host is the frame. Two subscriptions to one target
 * (different events, or a `once` beside a standing one) are one row.
 *
 * EXPORTED BECAUSE THE RAIL HAS TO ASK THE SAME QUESTION. `withholdFollowedRows`
 * keeps a followed session out of its project group, and "followed" has to mean
 * exactly the rows this block draws — a rail that computed the set a second way
 * would hide a row here and show it there, or the reverse, the moment the two
 * spellings drifted. One function, one answer, two callers.
 */
export function followedSessions(
  following: readonly Subscription[] | undefined,
  followed: readonly SidebarSession[] | undefined,
  coordinatorHostId?: string,
): { session: SidebarSession; subscriptionIds: string[] }[] {
  const seen = new Map<string, { session: SidebarSession; subscriptionIds: string[] }>();
  for (const subscription of following ?? []) {
    const match = followed?.find(
      (candidate) =>
        candidate.id === subscription.targetSessionId && (candidate.hostId ?? undefined) === (coordinatorHostId ?? undefined),
    );
    if (!match) continue;
    const key = sessionKey(match);
    const entry = seen.get(key);
    if (entry) entry.subscriptionIds.push(subscription.id);
    else seen.set(key, { session: match, subscriptionIds: [subscription.id] });
  }
  return [...seen.values()];
}

/** A flat list of rows, arranged into one level of parents and children. */
export type RelatedTree = {
  /** Rows still drawn at the list's own level, in the order they arrived. */
  rows: { session: SidebarSession; related: RelatedWorkGroups }[];
  /** Keys drawn as somebody's child, and so not drawn beside their parent. */
  nested: ReadonlySet<string>;
};

/**
 * THE TREE A FLAT LIST OF ROWS MAKES — issue #323, for a coordinator that is
 * NOT pinned.
 *
 * The pinned band has drawn its delegates underneath it since #199; everywhere
 * else the same sessions sat as siblings with nothing saying whose they were.
 * One shape for both is the whole point of the elbow: a reader should not have
 * to know a row is pinned to know what an indent means.
 *
 * SCOPED TO THE LIST IT IS GIVEN, which the caller makes one project group. A
 * child here is a row that list would otherwise draw beside its parent — moving
 * a row out of the project it belongs to is the PINNED band's bargain
 * (`withholdFollowedRows`, which pays for it with a chip on the group it took
 * from), and nothing about drawing a tree in place needs it.
 *
 * ONE LEVEL, AND FIRST POSITION WINS. A row already drawn — as somebody's child
 * or at the top level — is never claimed again, so two coordinators delegating
 * to one session is one row under the first of them, and a chain of delegations
 * reads as a list under its head rather than a staircase down the rail.
 *
 * AND A TREE IS SOMETHING ROWS LEAVE — issue #370. `relatedWork` drops a child
 * whose errand is over (`leavesRelatedWork`); this adds the other half, which
 * is about the PARENT: a settled coordinator claims nothing at all, so its
 * children stay rows of their own rather than being indented under a
 * conversation the reader has finished with. The two together are why an
 * indent in this rail always means live work.
 */
export function relatedTree(sessions: readonly SidebarSession[], options: RelatedWorkOptions = localSettling()): RelatedTree {
  const nested = new Set<string>();
  const drawn = new Set<string>();
  const rows: RelatedTree["rows"] = [];
  const none: RelatedWorkGroups = { active: [], review: [], independent: [] };
  for (const session of sessions) {
    const key = sessionKey(session);
    if (nested.has(key)) continue;
    drawn.add(key);
    // A SETTLED COORDINATOR IS NOT A PARENT. Nesting a live delegate under a
    // shelved row would hang current work off a conversation that is over — and
    // in a group whose settled rows are elsewhere, off a row that is not drawn.
    const found = settledRow(session, options) ? none : relatedWork(sessions, session, options);
    const claim = (candidates: readonly SidebarSession[]) =>
      candidates.filter((child) => {
        const childKey = sessionKey(child);
        if (nested.has(childKey) || drawn.has(childKey)) return false;
        nested.add(childKey);
        return true;
      });
    rows.push({
      session,
      related: { active: claim(found.active), review: claim(found.review), independent: claim(found.independent) },
    });
  }
  return { rows, nested };
}

export function RelatedWork({
  groups,
  coordinatorId,
  coordinatorHostId,
  following,
  followed,
  onUnfollow,
  onFollow,
  followFailed,
  lockFor,
  unfollowing,
  unfollowFailed,
}: {
  groups: RelatedWorkGroups;
  coordinatorId: string;
  /** The coordinator's Mac. Frames every id comparison below. */
  coordinatorHostId?: string;
  /** Subscriptions this session holds. */
  following?: readonly Subscription[];
  /** Rows for the sessions those subscriptions point at, when known. */
  followed?: readonly SidebarSession[];
  /**
   * Stop following. Takes EVERY subscription the row represents — a target can
   * be followed twice (different events, or a `once` beside a standing one), and
   * removing one would leave the row still followed while the control said
   * otherwise.
   */
  onUnfollow?: (targetKey: string, subscriptionIds: readonly string[]) => void;
  /** Lock id for a target row — coordinator and target, not target alone. */
  lockFor?: (targetKey: string) => string;
  /** Locks whose unfollow is in flight. */
  unfollowing?: ReadonlySet<string>;
  /** Locks whose unfollow failed. The row stays, and says so. */
  unfollowFailed?: ReadonlySet<string>;
  /** Start following a session this coordinator delegated to. */
  onFollow?: (target: SidebarSession) => void;
  /** Locks whose follow failed. The control stays and offers a retry. */
  followFailed?: ReadonlySet<string>;
}) {
  /** The same resolution the rail runs to keep these rows out of their project
   *  groups — see `followedSessions`. */
  const watched = followedSessions(following, followed, coordinatorHostId);
  /** Already followed, so a row offers Follow only when it is not. */
  const followedKeys = new Set(watched.map(({ session }) => sessionKey(session)));

  const empty =
    groups.active.length === 0 && groups.review.length === 0 && groups.independent.length === 0 && watched.length === 0;
  if (empty) return null;

  return (
    /* Labelled and given a role rather than left a bare div: the four headings
       were what named this block to a screen reader, and dropping them without
       this would leave the child rows floating among the rail's own. */
    <div role="group" aria-label="Related work" className="flex flex-col gap-0.5">
      {groups.active.map((session) => (
        <Row
          key={sessionKey(session)}
          session={session}
          // The scope the coordinator actually named beats the bare state — it
          // says which work, and "working" is then implied by there being any.
          hint={scopeOf(session.assignments, coordinatorId) ?? "working"}
          action={followButton(session, followedKeys, onFollow, lockFor?.(sessionKey(session)), unfollowing, followFailed)}
        />
      ))}

      {groups.review.map((session) => (
        <Row
          key={sessionKey(session)}
          session={session}
          hint="finished"
          action={followButton(session, followedKeys, onFollow, lockFor?.(sessionKey(session)), unfollowing, followFailed)}
        />
      ))}

      {/* PROVENANCE HAS NO STATE TO HINT. "Started from here" was a fact about
          the edge, not about the row, and the elbow is now that fact. */}
      {groups.independent.map((session) => (
        <Row key={sessionKey(session)} session={session} />
      ))}

      {watched.map(({ session, subscriptionIds }) => {
        const key = sessionKey(session);
        const lock = lockFor?.(key) ?? key;
        const pending = unfollowing?.has(lock) ?? false;
        const failed = unfollowFailed?.has(lock) ?? false;
        return (
          <Row
            key={key}
            session={session}
            {...(failed ? { hint: "could not unfollow" } : {})}
            action={
              onUnfollow ? (
                <button
                  type="button"
                  // The row is still followed until the engine says otherwise,
                  // so a failed attempt offers a retry rather than vanishing.
                  aria-label={`${failed ? "Retry stop following" : "Stop following"} ${session.title}`}
                  title={failed ? "Could not unfollow — try again" : "Stop following"}
                  disabled={pending}
                  onClick={() => onUnfollow(key, subscriptionIds)}
                  className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover/row:opacity-70 disabled:opacity-40"
                >
                  <BellOffIcon className="size-3.5" aria-hidden />
                </button>
              ) : null
            }
          />
        );
      })}
    </div>
  );
}
