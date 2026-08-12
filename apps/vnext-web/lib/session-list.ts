/**
 * The sidebar inbox's derivation, ported from the frozen app's
 * `lib/session-list.ts`.
 *
 * WHAT CHANGED AND WHY. The donor's inbox is built on four pieces of per-session
 * state the legacy store persisted — `readAt`, `snoozedUntil`, `settledAt` and a
 * per-request `live`/`needsApproval` join. The vNext engine's `Session` models
 * none of them (see `packages/engine-client/src/protocol/entities.ts`), and
 * `GET /v2/sessions` answers with Session records alone. So:
 *
 *   - UNREAD and SNOOZED are gone, not faked. A chip counting a number nothing
 *     backs is worse than no chip.
 *   - SETTLED SURVIVES, because it was always mostly derived: the donor shelves
 *     a row that is explicitly settled, archived, OR simply quiet for three
 *     days. `state: "archived"` and `updatedAt` back the second and third
 *     clauses exactly, so the banded list — live rows above, a collapsed shelf
 *     below — reads the same as it always did.
 *
 * Everything else here is the donor's logic verbatim: the same sort, the same
 * "search flattens every band", the same survivor rule that keeps the session
 * you are LOOKING AT visible after it ages into the shelf.
 */
import type { Session } from "@telar/engine-client";

export const SESSION_PAGE_SIZE = 20;
export const SETTLED_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * What a row needs to render. A projection of the engine's `Session` plus the
 * project NAME, which the record carries only as an id — the rail resolves it
 * once from the project list rather than making every row do it.
 */
export type SidebarSession = {
  id: string;
  title: string;
  projectId: string;
  /** Resolved display name. Absent while the project list is still loading. */
  projectName?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  driver: "claude" | "codex";
  model?: string;
  effort?: string;
  costUsd?: number;
  contextTokens?: number;
  workspacePath: string;
  worktreeBranch?: string;
};

/** The engine record, flattened into what the rail actually reads. */
export function toSidebarSession(session: Session, projectName?: string): SidebarSession {
  return {
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    ...(projectName ? { projectName } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archived: session.state === "archived",
    driver: session.driver,
    ...(session.model?.model ? { model: session.model.model } : {}),
    ...(session.model?.effort ? { effort: session.model.effort } : {}),
    ...(typeof session.usage?.costUsd === "number" ? { costUsd: session.usage.costUsd } : {}),
    ...(typeof session.usage?.contextUsed === "number" ? { contextTokens: session.usage.contextUsed } : {}),
    workspacePath: session.workspace.path,
    ...(session.workspace.mode === "worktree" ? { worktreeBranch: session.workspace.branch } : {}),
  };
}

/**
 * Which slice of the inbox the list is showing. "all" is the banded default
 * (active list + shelf); the other two are flat, shelf-less views over a single
 * predicate, which is what makes a chip feel like a filter rather than another
 * place shelves can hide rows.
 */
export type SessionFilter = "all" | "active" | "archived";

export type SessionBand = "active" | "settled";

export type SessionListInput = {
  sessions: readonly SidebarSession[];
  projectId?: string;
  query?: string;
  filter?: SessionFilter;
  activeSessionId?: string;
  now?: number;
  limit?: number;
  settledLimit?: number;
};

export type SessionListResult = {
  sessions: SidebarSession[];
  settled: SidebarSession[];
  settledCount: number;
  activeCount: number;
  archivedCount: number;
  hasMoreSessions: boolean;
  hasMoreSettled: boolean;
  /** True when the result is a flat, shelf-less view (search or a chip). */
  flat: boolean;
};

const createdNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * Which shelf a row belongs to.
 *
 * An archived session is settled by decision; a session nobody has touched for
 * three days is settled by neglect. The donor also had an explicit `settledAt`
 * between them, which vNext does not model — the two clauses that remain are
 * the ones the engine can actually answer.
 */
export function bandOf(session: SidebarSession, now: number): SessionBand {
  if (session.archived) return "settled";
  if (now - session.updatedAt >= SETTLED_AFTER_MS) return "settled";
  return "active";
}

function pageWithActive(
  rows: readonly SidebarSession[],
  limit: number,
  activeSessionId?: string,
): { rows: SidebarSession[]; hasMore: boolean } {
  const visible = rows.slice(0, limit);
  const active = activeSessionId ? rows.find((row) => row.id === activeSessionId) : undefined;
  if (active && !visible.some((row) => row.id === active.id)) visible.push(active);
  return { rows: visible, hasMore: rows.length > limit };
}

/** Pure derivation for the sidebar's session scope. */
export function deriveSessionList({
  sessions,
  projectId,
  query = "",
  filter = "all",
  activeSessionId,
  now = Date.now(),
  limit = SESSION_PAGE_SIZE,
  settledLimit = limit,
}: SessionListInput): SessionListResult {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const eligible = sessions
    .filter((session) => !projectId || session.projectId === projectId)
    .filter((session) => {
      if (!normalizedQuery) return true;
      return `${session.title} ${session.projectName ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort(createdNewestFirst);

  // Counted over the whole scope, not the visible page — these are the numbers
  // the chips wear, and a badge that only counts what is already on screen tells
  // you nothing you could not already see.
  const archivedCount = eligible.filter((session) => session.archived).length;
  const activeCount = eligible.length - archivedCount;

  // Search deliberately flattens every band. It is a transient command-like view
  // and should be able to recover a settled or archived session immediately. A
  // chip stays honored underneath it, so "archived" + a query reads as "archived
  // sessions matching this", not as a silently widened search.
  const flatPredicate =
    filter === "active"
      ? (session: SidebarSession) => !session.archived
      : filter === "archived"
        ? (session: SidebarSession) => session.archived
        : null;

  if (normalizedQuery || flatPredicate) {
    const rows = flatPredicate ? eligible.filter(flatPredicate) : eligible;
    const page = pageWithActive(rows, limit, activeSessionId);
    return {
      settled: [],
      settledCount: 0,
      sessions: page.rows,
      activeCount,
      archivedCount,
      hasMoreSessions: page.hasMore,
      hasMoreSettled: false,
      flat: true,
    };
  }

  const current: SidebarSession[] = [];
  const settled: SidebarSession[] = [];
  for (const session of eligible) {
    (bandOf(session, now) === "settled" ? settled : current).push(session);
  }

  // An open session remains reachable even when it has aged into the shelf.
  // Moving it into the live band avoids rendering the same row twice.
  const activeShelved = activeSessionId ? settled.find((session) => session.id === activeSessionId) : undefined;
  const currentWithSurvivor = activeShelved ? [...current, activeShelved].sort(createdNewestFirst) : current;
  const settledRest = activeShelved ? settled.filter((session) => session.id !== activeShelved.id) : settled;

  const currentPage = pageWithActive(currentWithSurvivor, limit, activeSessionId);
  const settledPage = pageWithActive(settledRest, settledLimit);

  return {
    sessions: currentPage.rows,
    settled: settledPage.rows,
    settledCount: settledRest.length,
    activeCount,
    archivedCount,
    hasMoreSessions: currentPage.hasMore,
    hasMoreSettled: settledPage.hasMore,
    flat: false,
  };
}

/** The route a session's own row links to — spelled once so every caller
 *  resolves to the exact same URL a click on the row would. */
export function sessionHref(session: Pick<SidebarSession, "id" | "projectId">): string {
  return `/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`;
}

export function activeSessionFromPathname(pathname: string): string | undefined {
  const match = /^\/projects\/[^/]+\/sessions\/([^/?#]+)/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
