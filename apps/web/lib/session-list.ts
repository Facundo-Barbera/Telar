export const SESSION_PAGE_SIZE = 20;
export const SETTLED_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export type SidebarSession = {
  id: string;
  title: string;
  project?: string;
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  archived?: boolean;
  role?: string;
  // Detail the row shows on hover rather than inline. All optional: these ride
  // along free on the list payload (listChats already projects every one), so
  // the hover card costs no extra request — but old persisted chats predate
  // some of them and must still render.
  model?: string;
  effort?: string;
  turns?: number;
  contextTokens?: number;
  /** One-line glimpse of the latest assistant reply, from listChats. */
  preview?: string;
  // ── inbox state (see lib/store.ts's Chat for what each one means) ──────────
  settledAt?: number;
  snoozedUntil?: number;
  readAt?: number;
  // Derived per request by GET /api/chats from the in-flight run registry —
  // never persisted, so a row can only claim to be running while a turn
  // actually is.
  live?: boolean;
  // Also derived per request by GET /api/chats, from a SEPARATE source: the
  // Ultra run registry (TELAR_HOME/ultra/*), joined on sessionId. A run
  // launched from this session keeps going as its own detached process after
  // the HTTP turn that launched it returns, so `live` above can already be
  // false while this session is still doing real work (issue #17) — the two
  // signals are independent and a row must be able to show either without
  // conflating them. Absent or 0 both mean "nothing running in the
  // background"; only a positive count is ever rendered.
  liveBackgroundRuns?: number;
};

// Which slice of the inbox the list is showing. "all" is the banded default
// (active list + shelves); the other three are flat, shelf-less views over a
// single predicate, which is what makes a chip feel like a filter rather than
// another place shelves can hide rows.
export type SessionFilter = "all" | "unread" | "snoozed" | "settled";

export type SessionBand = "active" | "snoozed" | "settled";

export type SessionListInput<T extends SidebarSession> = {
  sessions: readonly T[];
  project?: string;
  query?: string;
  filter?: SessionFilter;
  activeSessionId?: string;
  now?: number;
  limit?: number;
  settledLimit?: number;
  snoozedLimit?: number;
};

export type SessionListResult<T extends SidebarSession> = {
  sessions: T[];
  settled: T[];
  settledCount: number;
  snoozed: T[];
  snoozedCount: number;
  unreadCount: number;
  hasMoreSessions: boolean;
  hasMoreSettled: boolean;
  hasMoreSnoozed: boolean;
  /** True when the result is a flat, shelf-less view (search or a chip). */
  flat: boolean;
};

const isUserSession = (session: SidebarSession) =>
  session.role !== "steerer" && session.role !== "escalation";

const createdNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** A session is unread until something marks it read at or after its last turn. */
export function isUnread(session: SidebarSession): boolean {
  return (session.readAt ?? 0) < session.updatedAt;
}

/**
 * Which shelf a row belongs to, in precedence order.
 *
 * Snooze is checked first and beats every settle reason: it is the only state
 * carrying an explicit return time, so a row that is both snoozed and (say)
 * three-days quiet must read as snoozed or its wake-up would be invisible.
 * A snooze whose instant has passed is simply not a snooze any more — that is
 * why deferral needs no timer anywhere, only this comparison.
 */
export function bandOf(session: SidebarSession, now: number): SessionBand {
  if (session.snoozedUntil !== undefined && session.snoozedUntil > now) return "snoozed";
  if (session.settledAt !== undefined) return "settled";
  if (session.archived) return "settled";
  if (now - session.updatedAt >= SETTLED_AFTER_MS) return "settled";
  return "active";
}

function pageWithActive<T extends SidebarSession>(
  rows: readonly T[],
  limit: number,
  activeSessionId?: string,
): { rows: T[]; hasMore: boolean } {
  const visible = rows.slice(0, limit);
  const active = activeSessionId
    ? rows.find((row) => row.id === activeSessionId)
    : undefined;
  if (active && !visible.some((row) => row.id === active.id)) visible.push(active);
  return { rows: visible, hasMore: rows.length > limit };
}

// A function, not a shared literal: each call must hand back its own arrays,
// or two results would alias the same (mutable) empty shelves.
const emptyShelves = <T extends SidebarSession>() => ({
  settled: [] as T[],
  settledCount: 0,
  snoozed: [] as T[],
  snoozedCount: 0,
  hasMoreSettled: false,
  hasMoreSnoozed: false,
});

/** Pure derivation for the sidebar's project-local session scope. */
export function deriveSessionList<T extends SidebarSession>({
  sessions,
  project,
  query = "",
  filter = "all",
  activeSessionId,
  now = Date.now(),
  limit = SESSION_PAGE_SIZE,
  settledLimit = limit,
  snoozedLimit = limit,
}: SessionListInput<T>): SessionListResult<T> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const eligible = sessions
    .filter(isUserSession)
    .filter((session) => !project || session.project === project)
    .filter((session) => {
      if (!normalizedQuery) return true;
      return `${session.title} ${session.project ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    })
    .sort(createdNewestFirst);

  // Counted over the whole scope, not the visible page — this is the number the
  // Unread chip wears, and a badge that only counts what is already on screen
  // tells you nothing you could not already see.
  const unreadCount = eligible.filter(isUnread).length;

  // Search deliberately flattens every band. It is a transient command-like
  // view and should be able to recover a settled, snoozed or archived session
  // immediately. A chip stays honored underneath it, so "unread" + a query
  // reads as "unread sessions matching this", not as a silently widened search.
  const flatPredicate =
    filter === "unread"
      ? (session: T) => isUnread(session)
      : filter === "snoozed"
        ? (session: T) => bandOf(session, now) === "snoozed"
        : filter === "settled"
          ? (session: T) => bandOf(session, now) === "settled"
          : null;

  if (normalizedQuery || flatPredicate) {
    const rows = flatPredicate ? eligible.filter(flatPredicate) : eligible;
    const page = pageWithActive(rows, limit, activeSessionId);
    return {
      ...emptyShelves<T>(),
      sessions: page.rows,
      unreadCount,
      hasMoreSessions: page.hasMore,
      flat: true,
    };
  }

  const current: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];
  for (const session of eligible) {
    const band = bandOf(session, now);
    (band === "snoozed" ? snoozed : band === "settled" ? settled : current).push(session);
  }

  // An open session remains reachable even when it has aged into a shelf.
  // Moving it into the live band avoids rendering the same row twice.
  const shelved = [...snoozed, ...settled];
  const activeShelved = activeSessionId
    ? shelved.find((session) => session.id === activeSessionId)
    : undefined;
  const currentWithSurvivor = activeShelved
    ? [...current, activeShelved].sort(createdNewestFirst)
    : current;
  const withoutSurvivor = <R extends SidebarSession>(rows: R[]) =>
    activeShelved ? rows.filter((session) => session.id !== activeShelved.id) : rows;
  const snoozedRest = withoutSurvivor(snoozed);
  const settledRest = withoutSurvivor(settled);

  const currentPage = pageWithActive(currentWithSurvivor, limit, activeSessionId);
  const snoozedPage = pageWithActive(snoozedRest, snoozedLimit);
  const settledPage = pageWithActive(settledRest, settledLimit);

  return {
    sessions: currentPage.rows,
    settled: settledPage.rows,
    settledCount: settledRest.length,
    snoozed: snoozedPage.rows,
    snoozedCount: snoozedRest.length,
    unreadCount,
    hasMoreSessions: currentPage.hasMore,
    hasMoreSettled: settledPage.hasMore,
    hasMoreSnoozed: snoozedPage.hasMore,
    flat: false,
  };
}

/**
 * Where settling or archiving the session you are currently viewing should
 * send you (issue #12). A fresh, unpersisted composer in the SAME project —
 * not `/`, which server-redirects to whichever project's most-recently-
 * updated chat happens to be (app/page.tsx), and could easily be a different
 * project than the one you were just working in. The session's own already-
 * known `project` is a fact the caller already has; this just spells the
 * route consistently everywhere it is needed (session-row.tsx,
 * session-inbox-menu.tsx, app/projects/[name]/page.tsx's own inline copy).
 */
export function newSessionHref(project: string): string {
  return `/projects/${encodeURIComponent(project)}/sessions/new`;
}

/** The route a session's own row/dock links land on — shared here so the
 *  command-keys jump bindings (issue #16) resolve to the exact same URL a
 *  click on the row would, rather than a second, hand-rolled copy of it. */
export function sessionHref(session: Pick<SidebarSession, "id" | "project">): string | undefined {
  return session.project
    ? `/projects/${encodeURIComponent(session.project)}/sessions/${encodeURIComponent(session.id)}`
    : undefined;
}

/**
 * What cmd+1..cmd+9 (issue #16) index into: exactly the sidebar's own
 * unfiltered, unsearched "Recent" band — every user session (no
 * steerer/escalation), newest-created-first, across every project — because
 * that is the one ordering a person already sees and can predict without
 * opening the sidebar to check. Reuses deriveSessionList itself rather than
 * re-sorting, so "recent" can never drift from what the sidebar renders.
 *
 * `limit: 9` still allows a 10th entry through — deriveSessionList's own
 * pageWithActive pins the currently-open session onto the page even past the
 * limit if it would otherwise fall off. That pin is meaningless for
 * indexing (it can land the open session anywhere, not just position 10), so
 * the trailing slice always cuts back to the strict top 9.
 */
export function recentSessionsForCommandKeys<T extends SidebarSession>(
  sessions: readonly T[],
  now = Date.now(),
): T[] {
  return deriveSessionList({ sessions, now, limit: 9 }).sessions.slice(0, 9);
}

export function activeSessionFromPathname(pathname: string): string | undefined {
  const match = /^\/projects\/[^/]+\/sessions\/([^/?#]+)/.exec(pathname);
  if (!match || match[1] === "new") return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
