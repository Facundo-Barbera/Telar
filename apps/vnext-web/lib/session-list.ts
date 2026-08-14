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
import type { Session, SessionActivity } from "@telar/engine-client";
import { DEFAULT_AUTO_SETTLE_DAYS, isSettled } from "./session-settling";

export const SESSION_PAGE_SIZE = 20;
/** Kept for the callers that describe the window in prose. The rule itself now
 *  takes the window as a parameter — see `bandOf`. */
export const SETTLED_AFTER_MS = DEFAULT_AUTO_SETTLE_DAYS * 24 * 60 * 60 * 1000;

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
  /** Everything this session has spent, in tokens. Money is not a unit this
   *  cockpit reports — see lib/format.ts. */
  tokens?: number;
  contextTokens?: number;
  workspacePath: string;
  worktreeBranch?: string;
  /** The project checkout's current branch, for a LOCAL session — which has no
   *  branch of its own because it runs on the project's own checkout. Derived
   *  per project by the engine, not stored. */
  projectBranch?: string;
  /** The inbox's own state — see `lib/session-settling.ts`. Carried on the
   *  projection rather than looked up, because `bandOf` runs per row per
   *  render and the whole point of the projection is that it already has
   *  everything a row needs. */
  settledOverride?: "settled" | "active";
  settledAt?: number;
  snoozedUntil?: number;
  snoozedAt?: number;
  /**
   * WHAT THIS SESSION IS DOING, straight from the engine.
   *
   * The field that turns this list into an inbox: without it a row can only
   * report recency, which is also the sort order, so the line restates the
   * position. See `lib/session-activity.ts` for what a row does with it.
   */
  activity: SessionActivity;
  /** When that began — for "Working 3m". Absent on `idle`, which has no event
   *  to date. */
  activityAt?: number;
};

/** The engine record, flattened into what the rail actually reads. */
export function toSidebarSession(session: Session, projectName?: string, projectBranch?: string): SidebarSession {
  return {
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    ...(projectName ? { projectName } : {}),
    ...(projectBranch ? { projectBranch } : {}),
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
    workspacePath: session.workspace.path,
    ...(session.workspace.mode === "worktree" ? { worktreeBranch: session.workspace.branch } : {}),
    ...(session.settledOverride ? { settledOverride: session.settledOverride } : {}),
    ...(session.settledAt === undefined ? {} : { settledAt: session.settledAt }),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    activity: session.activity,
    ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
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
 * THE THIRD CLAUSE ARRIVED. This used to answer with the two the engine could
 * back — archived, or quiet for three days — and said so. The engine now stores
 * an explicit pin in either direction, so the rule moved to
 * `lib/session-settling.ts` where it can be read in one place and the ordering
 * that makes it safe (blockers first) is stated once.
 *
 * ACTIVITY IS NOT PASSED HERE, and that is a deliberate limit rather than an
 * oversight: the sidebar lists every session in the project and does not hold a
 * live turn state for each. A row that is running is therefore classified on
 * its stored fields alone — which is correct for the pin and the clock, and
 * means a settled session with a turn running is not rescued into the list
 * until something tells this list about it. `SessionRow` passes what it knows.
 */
export function bandOf(session: SidebarSession, now: number, autoSettleAfterDays: number | null = DEFAULT_AUTO_SETTLE_DAYS): SessionBand {
  return isSettled(session, {}, { now, autoSettleAfterDays }) ? "settled" : "active";
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

/**
 * The new-conversation canvas for a project — spelled once for the same reason
 * `sessionHref` is, and with a sharper edge: the cockpit now decides whether it
 * is showing a canvas or a session by COMPARING the pathname to this string, so
 * a second spelling anywhere would be a screen that never resets.
 */
export function canvasHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
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
