"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRightIcon, BellIcon, BellOffIcon, UsersIcon } from "lucide-react";
import type { SessionAssignment, Subscription } from "@telar/engine-client";
import { PanelEmpty, PanelRow, PanelSectionLabel, type PanelTone } from "@/components/ui/panel";
import { usePoll } from "@/ui/hooks/use-poll";
import { createEngineApi } from "@/platform/engine/index";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { hostFetcher } from "@/lib/hosts/client";
import { createFollowingController, lockKey, type FollowingController } from "@/lib/following";
import { fmtAgo } from "@/lib/format";
import { activityBadge } from "../session-activity";
import { relatedWork, sessionHref, sessionKey, toSidebarSession, type SidebarSession } from "../session-list";
import { cn } from "@/lib/utils";

type Outcome = NonNullable<SessionAssignment["outcome"]>;

type RelationKind = "assigned" | "finished" | "started" | "followed";

export type Delegate = {
  session: SidebarSession;
  kind: RelationKind;
  scope?: string;
  outcome?: Outcome;
  at?: number;
  subscriptionIds: string[];
};

export type Employer = {
  session?: SidebarSession;
  sessionId: string;
  scope?: string;
  outcome?: Outcome;
  at: number;
  outstanding: boolean;
  unresolved: boolean;
};

const outstandingFrom = (assignments: readonly SessionAssignment[] | undefined, coordinatorId: string) =>
  assignments?.find((a) => a.fromSessionId === coordinatorId && a.outcome === undefined && !a.unresolved);

const endedFrom = (assignments: readonly SessionAssignment[] | undefined, coordinatorId: string) =>
  assignments?.filter((a) => a.fromSessionId === coordinatorId && a.outcome !== undefined && a.outcome !== "detached").at(-1);

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

function delegateState(entry: Delegate): { label: string; tone: PanelTone } {
  if (entry.kind === "finished" && entry.outcome) return { label: OUTCOME[entry.outcome], tone: OUTCOME_TONE[entry.outcome] };
  const badge = activityBadge(entry.session);
  if (!badge) return { label: entry.kind === "assigned" ? "Working" : "Idle", tone: "none" };
  return { label: badge.label, tone: badge.tone === "attention" ? "attention" : badge.tone === "live" ? "active" : "none" };
}

function detailOf(entry: Delegate, now: number): string | undefined {
  const parts: string[] = [];
  if (entry.scope) parts.push(entry.scope);
  else if (entry.kind === "started") parts.push("started from here");
  else if (entry.kind === "followed") parts.push("following");
  if (entry.at !== undefined) parts.push(fmtAgo(entry.at, now));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

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
    <PanelRow className="group/row gap-1.5 p-0 pl-0">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-4 hover:bg-muted/60">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-xs">{title}</span>
          {detail && <span className="truncate text-3xs text-muted-foreground">{detail}</span>}
        </span>
        {state && (
          <span className={cn("shrink-0 font-mono text-3xs", tone === "danger" ? "text-destructive" : "text-muted-foreground")}>
            {state}
          </span>
        )}
        <ArrowUpRightIcon className="size-3 shrink-0 opacity-40" aria-hidden />
      </Link>
      {action && <span className="shrink-0 pr-2">{action}</span>}
    </PanelRow>
  );
}

type Read = {
  rows: SidebarSession[];
  following: Subscription[];
  failed: boolean;
  done: boolean;
  at: number;
};

const EMPTY_READ: Read = { rows: [], following: [], failed: false, done: false, at: 0 };

function useRelated(sessionId: string | undefined, hostId: string | undefined, visible: boolean, nudge: number): Read {
  const [read, setRead] = useState<Read>(EMPTY_READ);
  usePoll(
    async (signal) => {
      if (!sessionId) return;
      const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
      const [list, subscriptions] = await Promise.all([
        api.liveSessions({ all: true }).then((value) => value, () => undefined),
        api.sessionSubscriptions(sessionId).then((value) => value.subscriptions, () => undefined),
      ]);
      if (signal.aborted) return;
      setRead((current) => ({
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
    },
    sessionId && visible ? 10_000 : null,
    { key: `${sessionId}:${hostId}:${nudge}` },
  );
  return read;
}

export function RelatedConversations({
  sessionId,
  hostId,
  visible = true,
}: {
  sessionId?: string;
  hostId?: string;
  visible?: boolean;
}) {
  const [nudge, setNudge] = useState(0);
  const read = useRelated(sessionId, hostId, visible, nudge);
  const [follow] = useState<FollowingController>(() => createFollowingController(() => {}));
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  const coordinator = useMemo<Pick<SidebarSession, "id" | "hostId"> | undefined>(
    () => (sessionId ? { id: sessionId, ...(hostId ? { hostId } : {}) } : undefined),
    [sessionId, hostId],
  );

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
  lockFor?: (targetKey: string) => string;
  onToggleFollow?: (entry: Delegate) => void;
  busy?: ReadonlySet<string>;
  failed?: ReadonlySet<string>;
  read?: "reading" | "done" | "failed";
  now: number;
}) {
  const stamp = now;

  if (delegates.length === 0 && employers.length === 0) {
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
          <PanelSectionLabel label="Working for this conversation" count={delegates.length} />
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
          <PanelSectionLabel label="Working for" count={employers.length} />
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
              <PanelRow key={`${entry.sessionId}:${entry.at}:${index}`} className="gap-1.5 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs text-muted-foreground">{title}</span>
                  <span className="truncate text-3xs text-muted-foreground">{[detail, "no longer listed"].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="shrink-0 font-mono text-3xs text-muted-foreground">{state}</span>
              </PanelRow>
            );
          })}
        </>
      )}
    </div>
  );
}
