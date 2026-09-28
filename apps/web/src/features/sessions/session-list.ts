import {
  DEFAULT_AUTO_SETTLE_HOURS,
  type LiveSessionRow,
  type ProjectAvailability,
  type SessionActivity,
  type SessionActivityDetail,
  type SessionAssignment,
  type SessionPreparation,
  type ProviderDriverKind,
  type SessionSettledBy,
  workspacePath,
} from "@telar/engine-client";
import { isShelved, isSnoozed, settlingActivityOf, type SettlingActivity, type SettlingOptions } from "./session-settling";
import { hostPrefix } from "@/platform/engine/host-client";

export const SESSION_PAGE_SIZE = 20;
export const SETTLED_PAGE_SIZE = 10;
export const SETTLED_AFTER_MS = DEFAULT_AUTO_SETTLE_HOURS * 60 * 60 * 1000;

export type SidebarSession = {
  draft?: boolean;
  id: string;
  title: string;
  hostId?: string;
  hostName?: string;
  assignments?: readonly SessionAssignment[];
  startedFrom?: { sessionId: string; runId?: string };
  projectId?: string;
  projectName?: string;
  projectIcon?: string;
  projectIconName?: string;
  projectRemote?: string;
  projectAvailability?: ProjectAvailability;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  driver: ProviderDriverKind;
  model?: string;
  effort?: string;
  tokens?: number;
  contextTokens?: number;
  workspacePath?: string;
  worktreeBranch?: string;
  preparation?: SessionPreparation;
  projectBranch?: string;
  settledOverride?: "settled" | "active";
  settledAt?: number;
  settledBy?: SessionSettledBy;
  settledForTitle?: string;
  terminals?: number;
  terminalsClosed?: { at: number; terminals: number; reason: "grace" | "limit" };
  snoozedUntil?: number;
  snoozedAt?: number;
  wokeAt?: number;
  activity: SessionActivity;
  activityAt?: number;
  activityDetail?: SessionActivityDetail;
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  readAt?: number;
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
  stale?: number;
};

export function toSidebarSession(
  session: LiveSessionRow,
  projectName?: string,
  projectBranch?: string,
  projectIcon?: string,
  host?: { id: string; name: string },
  assignments?: readonly SessionAssignment[],
  projectRemote?: string,
  projectIconName?: string,
  coordinatorTitle?: string,
  projectAvailability?: ProjectAvailability,
  terminals?: number,
): SidebarSession {
  return {
    id: session.id,
    title: session.title,
    ...(assignments && assignments.length > 0 ? { assignments } : {}),
    ...(session.startedFrom ? { startedFrom: session.startedFrom } : {}),
    ...(session.draft ? { draft: true } : {}),
    ...(host ? { hostId: host.id, hostName: host.name } : {}),
    projectId: session.projectId,
    ...(projectName ? { projectName } : {}),
    ...(projectBranch ? { projectBranch } : {}),
    ...(projectIcon ? { projectIcon } : {}),
    ...(projectIconName ? { projectIconName } : {}),
    ...(projectRemote ? { projectRemote } : {}),
    ...(projectAvailability ? { projectAvailability } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archived: session.state === "archived",
    driver: session.driver,
    ...(session.model?.model ? { model: session.model.model } : {}),
    ...(session.model?.effort ? { effort: session.model.effort } : {}),
    ...(session.usage
      ? {
          tokens:
            session.usage.tokens.input +
            session.usage.tokens.output +
            session.usage.tokens.cacheRead +
            session.usage.tokens.cacheCreate,
        }
      : {}),
    ...(typeof session.usage?.contextUsed === "number" ? { contextTokens: session.usage.contextUsed } : {}),
    ...(workspacePath(session.workspace) ? { workspacePath: workspacePath(session.workspace)! } : {}),
    ...(session.workspace.mode === "worktree" ? { worktreeBranch: session.workspace.branch } : {}),
    ...(session.preparation === undefined ? {} : { preparation: session.preparation }),
    ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
    ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
    ...(session.settledBy ? { settledBy: session.settledBy } : {}),
    ...(session.settledBy && coordinatorTitle ? { settledForTitle: coordinatorTitle } : {}),
    ...(terminals ? { terminals } : {}),
    ...(session.terminalsClosed ? { terminalsClosed: session.terminalsClosed } : {}),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    ...(session.wokeAt === undefined ? {} : { wokeAt: session.wokeAt }),
    activity: session.activity,
    ...(session.activityDetail === undefined ? {} : { activityDetail: session.activityDetail }),
    ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
    ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
    ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
    ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
    ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
    ...(session.lastTurnFailed ? { lastTurnFailed: true } : {}),
  };
}

export function settlingActivity(session: SidebarSession): SettlingActivity {
  return settlingActivityOf(session);
}

export function settledHint(session: Pick<SidebarSession, "settledBy" | "settledForTitle">): string | undefined {
  if (!session.settledBy) return undefined;
  return session.settledForTitle
    ? `Settled after its work for ${session.settledForTitle} was delivered`
    : "Settled after its delegated work was delivered";
}

export type SessionBand = "pinned" | "active" | "snoozed" | "settled";

export type SessionListInput = {
  sessions: readonly SidebarSession[];
  projectId?: string;
  query?: string;
  activeSessionId?: string;
  now?: number;
  autoSettleAfterHours?: number | null;
  windowsByHost?: ReadonlyMap<string, number | null>;
  limit?: number;
  settledLimit?: number;
  order?: "created" | "activity";
};

export function windowFor(
  session: Pick<SidebarSession, "hostId">,
  fallback: number | null,
  windowsByHost?: ReadonlyMap<string, number | null>,
): number | null {
  if (!windowsByHost) return fallback;
  const own = windowsByHost.get(session.hostId ?? "local");
  return own === undefined ? fallback : own;
}

export type SessionListResult = {
  pinned: SidebarSession[];
  sessions: SidebarSession[];
  snoozed: SidebarSession[];
  snoozedCount: number;
  settled: SidebarSession[];
  settledCount: number;
  hasMoreSessions: boolean;
  hasMoreSettled: boolean;
  flat: boolean;
};

const createdNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

function lastActivityAt(session: Pick<SidebarSession, "updatedAt" | "activityAt" | "lastTurnEndedAt">): number {
  return Math.max(session.updatedAt, session.activityAt ?? 0, session.lastTurnEndedAt ?? 0);
}

const activeNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  lastActivityAt(b) - lastActivityAt(a) || createdNewestFirst(a, b);

export function bandOf(session: SidebarSession, options: SettlingOptions): SessionBand {
  const activity = settlingActivity(session);
  if (isSnoozed(session, activity, options)) return "snoozed";
  if (session.settledOverride === "active") return "pinned";
  return isShelved(session, activity, options) ? "settled" : "active";
}

export type RelatedWork = {
  active: SidebarSession[];
  review: SidebarSession[];
  independent: SidebarSession[];
};

export function relatedWork(
  sessions: readonly SidebarSession[],
  coordinator: Pick<SidebarSession, "id" | "hostId">,
): RelatedWork {
  const host = coordinator.hostId;
  const related: RelatedWork = { active: [], review: [], independent: [] };
  for (const session of sessions) {
    if (sessionKey(session) === sessionKey(coordinator)) continue;
    if ((session.hostId ?? undefined) !== (host ?? undefined)) continue;
    const mine = (session.assignments ?? []).filter((assignment) => assignment.fromSessionId === coordinator.id);
    if (mine.some((assignment) => assignment.outcome === undefined && !assignment.unresolved)) {
      related.active.push(session);
      continue;
    }
    if (mine.some((assignment) => assignment.outcome !== undefined && assignment.outcome !== "detached")) {
      related.review.push(session);
      continue;
    }
    if (session.startedFrom?.sessionId === coordinator.id) related.independent.push(session);
  }
  return related;
}

export function sessionKey(session: Pick<SidebarSession, "id" | "hostId">): string {
  return session.hostId ? `${session.hostId}:${session.id}` : session.id;
}

function pageWithActive(
  rows: readonly SidebarSession[],
  limit: number,
  activeSessionId?: string,
): { rows: SidebarSession[]; hasMore: boolean } {
  const visible = rows.slice(0, limit);
  const active = activeSessionId ? rows.find((row) => sessionKey(row) === activeSessionId) : undefined;
  if (active && !visible.some((row) => sessionKey(row) === sessionKey(active))) visible.push(active);
  return { rows: visible, hasMore: rows.length > limit };
}

export function deriveSessionList({
  sessions,
  projectId,
  query = "",
  activeSessionId,
  now = Date.now(),
  autoSettleAfterHours = DEFAULT_AUTO_SETTLE_HOURS,
  windowsByHost,
  limit = SESSION_PAGE_SIZE,
  settledLimit = limit,
  order = "created",
}: SessionListInput): SessionListResult {
  const newestFirst = order === "activity" ? activeNewestFirst : createdNewestFirst;
  const optionsFor = (session: SidebarSession): SettlingOptions => ({ now, autoSettleAfterHours: windowFor(session, autoSettleAfterHours, windowsByHost) });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const eligible = sessions
    .filter((session) => !projectId || session.projectId === projectId)
    .filter((session) => {
      if (!normalizedQuery) return true;
      return `${session.title} ${session.projectName ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort(newestFirst);

  if (normalizedQuery) {
    const page = pageWithActive(eligible, limit, activeSessionId);
    return {
      pinned: [],
      sessions: page.rows,
      snoozed: [],
      snoozedCount: 0,
      settled: [],
      settledCount: 0,
      hasMoreSessions: page.hasMore,
      hasMoreSettled: false,
      flat: true,
    };
  }

  const pinned: SidebarSession[] = [];
  const current: SidebarSession[] = [];
  const snoozed: SidebarSession[] = [];
  const settled: SidebarSession[] = [];
  for (const session of eligible) {
    const band = bandOf(session, optionsFor(session));
    (band === "pinned" ? pinned : band === "snoozed" ? snoozed : band === "settled" ? settled : current).push(session);
  }

  const activeSnoozed = activeSessionId ? snoozed.find((session) => sessionKey(session) === activeSessionId) : undefined;
  const currentWithSurvivor = activeSnoozed ? [...current, activeSnoozed].sort(newestFirst) : current;
  const snoozedRest = activeSnoozed ? snoozed.filter((session) => sessionKey(session) !== sessionKey(activeSnoozed)) : snoozed;

  const currentPage = pageWithActive(currentWithSurvivor, limit, activeSessionId);
  const settledPage = pageWithActive(settled, settledLimit, activeSessionId);

  return {
    pinned,
    sessions: currentPage.rows,
    snoozed: snoozedRest.slice().sort((left, right) => (left.snoozedUntil ?? 0) - (right.snoozedUntil ?? 0)),
    snoozedCount: snoozedRest.length,
    settled: settledPage.rows,
    settledCount: settled.length,
    hasMoreSessions: currentPage.hasMore,
    hasMoreSettled: settledPage.hasMore,
    flat: false,
  };
}

export function sessionHref(session: Pick<SidebarSession, "id" | "projectId" | "hostId">): string {
  if (!session.projectId) return `${hostPrefix(session.hostId)}/main`;
  return `${hostPrefix(session.hostId)}/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`;
}

export function canvasHref(projectId: string, hostId?: string, options?: { baseRef?: string }): string {
  const canvas = `${hostPrefix(hostId)}/projects/${encodeURIComponent(projectId)}/sessions/new`;
  return options?.baseRef ? `${canvas}?base=${encodeURIComponent(options.baseRef)}` : canvas;
}

export function activeSessionFromPathname(pathname: string): string | undefined {
  const match = /^(?:\/hosts\/([^/]+))?\/projects\/[^/]+\/sessions\/([^/?#]+)/.exec(pathname);
  if (!match) return undefined;
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const id = decode(match[2]);
  return match[1] ? `${decode(match[1])}:${id}` : id;
}

export function canvasProjectFromPathname(pathname: string): string | undefined {
  const match = /^(?:\/hosts\/[^/]+)?\/projects\/([^/]+)\/sessions\/new\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
