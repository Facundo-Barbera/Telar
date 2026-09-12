"use client";

/**
 * RELATED WORK — four relationships, kept apart because they mean different
 * things.
 *
 *   Working on behalf of   current assignments from this session; they END
 *   Awaiting review        finished, not settled — still here so a delegated
 *                          result is not hidden the moment its run ended
 *   Started from here      permanent provenance; a free continuation has only this
 *   Following              a revocable wish to be woken, and nothing more
 *
 * None confers permission and none is a lifetime. Rows link through
 * `sessionHref`, which carries the host prefix — two Macs can mint one id.
 */
import Link from "next/link";
import { ArrowUpRightIcon, BellIcon, BellOffIcon, CircleCheckIcon, GitBranchIcon, LoaderIcon } from "lucide-react";
import type { SessionAssignment, Subscription } from "@telar/engine-client";
import { sessionHref, sessionKey, type RelatedWork as RelatedWorkGroups, type SidebarSession } from "@/lib/session-list";
import { Badge } from "@/components/ui/badge";

/** One row: what the session is called, and how to get to it. */
function Row({
  session,
  hint,
  icon: Icon,
  action,
}: {
  session: SidebarSession;
  hint?: string;
  icon: typeof BellIcon;
  action?: React.ReactNode;
}) {
  return (
    <Link
      href={sessionHref(session)}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted"
    >
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="truncate">{session.title}</span>
      {session.hostName && (
        <Badge variant="outline" className="shrink-0 text-[0.625rem]">
          {session.hostName}
        </Badge>
      )}
      {hint && <span className="ml-auto shrink-0 truncate opacity-60">{hint}</span>}
      <ArrowUpRightIcon className="size-3 shrink-0 opacity-40" aria-hidden />
    </Link>
  );
}

/** A row plus a control beside it, so the link stays a link. */
function RowWithAction({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="group/row flex items-center">
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <h3 className="px-2 pt-2 text-[0.6875rem] font-medium uppercase tracking-wide opacity-50">{title}</h3>
      {children}
    </section>
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
 * WHICH ROWS THE "FOLLOWING" GROUP ACTUALLY DRAWS, as `{ session, subscriptionIds }`.
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
    <div className="flex flex-col gap-1" aria-label="Related work">
      {groups.active.length > 0 && (
        <Group title="Working on behalf of">
          {groups.active.map((session) => (
            <RowWithAction
              key={sessionKey(session)}
              action={followButton(session, followedKeys, onFollow, lockFor?.(sessionKey(session)), unfollowing, followFailed)}
            >
              <Row session={session} icon={LoaderIcon} hint={scopeOf(session.assignments, coordinatorId)} />
            </RowWithAction>
          ))}
        </Group>
      )}

      {groups.review.length > 0 && (
        <Group title="Awaiting review">
          {groups.review.map((session) => (
            <RowWithAction key={sessionKey(session)} action={followButton(session, followedKeys, onFollow, lockFor?.(sessionKey(session)), unfollowing, followFailed)}>
              <Row session={session} icon={CircleCheckIcon} hint="finished" />
            </RowWithAction>
          ))}
        </Group>
      )}

      {groups.independent.length > 0 && (
        <Group title="Started from here">
          {groups.independent.map((session) => (
            <Row key={sessionKey(session)} session={session} icon={GitBranchIcon} />
          ))}
        </Group>
      )}

      {watched.length > 0 && (
        <Group title="Following">
          {watched.map(({ session, subscriptionIds }) => {
            const key = sessionKey(session);
            const lock = lockFor?.(key) ?? key;
            const pending = unfollowing?.has(lock) ?? false;
            const failed = unfollowFailed?.has(lock) ?? false;
            return (
              <div key={key} className="group/follow flex items-center">
                <div className="min-w-0 flex-1">
                  <Row session={session} icon={BellIcon} {...(failed ? { hint: "could not unfollow" } : {})} />
                </div>
                {onUnfollow && (
                  <button
                    type="button"
                    // The row is still followed until the engine says otherwise,
                    // so a failed attempt offers a retry rather than vanishing.
                    aria-label={`${failed ? "Retry stop following" : "Stop following"} ${session.title}`}
                    title={failed ? "Could not unfollow — try again" : "Stop following"}
                    disabled={pending}
                    onClick={() => onUnfollow(key, subscriptionIds)}
                    className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-muted group-hover/follow:opacity-70 disabled:opacity-40"
                  >
                    <BellOffIcon className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </Group>
      )}
    </div>
  );
}
