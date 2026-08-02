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
};

export type SessionListInput<T extends SidebarSession> = {
  sessions: readonly T[];
  project?: string;
  query?: string;
  activeSessionId?: string;
  now?: number;
  limit?: number;
  settledLimit?: number;
};

export type SessionListResult<T extends SidebarSession> = {
  sessions: T[];
  settled: T[];
  settledCount: number;
  hasMoreSessions: boolean;
  hasMoreSettled: boolean;
};

const isUserSession = (session: SidebarSession) =>
  session.role !== "steerer" && session.role !== "escalation";

const createdNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

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

/** Pure derivation for the sidebar's project-local session scope. */
export function deriveSessionList<T extends SidebarSession>({
  sessions,
  project,
  query = "",
  activeSessionId,
  now = Date.now(),
  limit = SESSION_PAGE_SIZE,
  settledLimit = limit,
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

  // Search deliberately flattens both bands. It is a transient command-like
  // view and should be able to recover archived or quiet sessions immediately.
  if (normalizedQuery) {
    const page = pageWithActive(eligible, limit, activeSessionId);
    return {
      sessions: page.rows,
      settled: [],
      settledCount: 0,
      hasMoreSessions: page.hasMore,
      hasMoreSettled: false,
    };
  }

  const current: T[] = [];
  const settled: T[] = [];
  for (const session of eligible) {
    const quiet = now - session.updatedAt >= SETTLED_AFTER_MS;
    (session.archived || quiet ? settled : current).push(session);
  }

  // An open session remains reachable even when it has aged into the collapsed
  // shelf. Moving it into the live band avoids rendering the same row twice.
  const activeSettled = activeSessionId
    ? settled.find((session) => session.id === activeSessionId)
    : undefined;
  const currentWithSurvivor = activeSettled
    ? [...current, activeSettled].sort(createdNewestFirst)
    : current;
  const settledWithoutSurvivor = activeSettled
    ? settled.filter((session) => session.id !== activeSettled.id)
    : settled;
  const currentPage = pageWithActive(currentWithSurvivor, limit, activeSessionId);
  const settledPage = pageWithActive(settledWithoutSurvivor, settledLimit);

  return {
    sessions: currentPage.rows,
    settled: settledPage.rows,
    settledCount: settledWithoutSurvivor.length,
    hasMoreSessions: currentPage.hasMore,
    hasMoreSettled: settledPage.hasMore,
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
