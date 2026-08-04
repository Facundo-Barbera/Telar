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

export function activeSessionFromPathname(pathname: string): string | undefined {
  const match = /^\/projects\/[^/]+\/sessions\/([^/?#]+)/.exec(pathname);
  if (!match || match[1] === "new") return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
