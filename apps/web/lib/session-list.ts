/**
 * The sidebar inbox's derivation, ported from the frozen app's
 * `lib/session-list.ts`.
 *
 * FOUR BANDS, IN THE DONOR'S PRECEDENCE ORDER — and the order IS the design:
 *
 *   1. SNOOZED, which outranks everything including the pin. "Hide this until
 *      Tuesday" temporarily suspends "keep this on top"; the pin survives
 *      underneath and the row returns to it on waking.
 *   2. PINNED — `settledOverride: "active"`, the explicit keep-in-the-list.
 *      Fixed at the top, and never paged: a band you chose the contents of is
 *      not one that should make you press "Show more".
 *   3. SETTLED, by decision or by the clock.
 *   4. ACTIVE, which is everything left.
 *
 * SNOOZE USED TO BE WRITTEN DOWN AND THEN IGNORED. The engine stored
 * `snoozedUntil`, the row offered five presets, `lib/session-settling.ts`
 * implemented the whole rule including early wakes — and this file never called
 * `isSnoozed`, so pressing "In 1 hour" wrote a timestamp and changed nothing on
 * screen. That is the worst kind of missing feature, because every part of it
 * that a reader can see says it works.
 *
 * `readAt` REMAINS UNMODELLED, so unread is still absent rather than faked.
 *
 * Everything else here is the donor's logic verbatim: the same sort, the same
 * "search flattens every band", the same survivor rule that keeps the session
 * you are LOOKING AT visible after it drops into a shelf.
 */
import { DEFAULT_AUTO_SETTLE_HOURS, type Session, type SessionActivity } from "@telar/engine-client";
import { isSettled, isSnoozed, type SettlingActivity, type SettlingOptions } from "./session-settling";
import { hostPrefix } from "./hosts/client";

export const SESSION_PAGE_SIZE = 20;
/** The settled shelf's own page. Smaller than the live list's, because the
 *  shelf is history: months of it accumulate, and opening the shelf should
 *  answer "what did I just finish" without burying the two live rows below
 *  a hundred dead ones. "Show more" walks the rest. */
export const SETTLED_PAGE_SIZE = 10;
/** Kept for the callers that describe the window in prose. The rule itself
 *  takes the window as a parameter — see `bandOf`. */
export const SETTLED_AFTER_MS = DEFAULT_AUTO_SETTLE_HOURS * 60 * 60 * 1000;

/**
 * What a row needs to render. A projection of the engine's `Session` plus the
 * project NAME, which the record carries only as an id — the rail resolves it
 * once from the project list rather than making every row do it.
 */
export type SidebarSession = {
  id: string;
  title: string;
  /**
   * WHICH MAC. Absent for the local engine — the common case, and the one
   * every existing caller already has. A remote session carries the host's
   * id (its routes live under `/hosts/:id/…`) and the label a row shows. Two
   * Macs can mint the same session id, so `id` alone is not a key once these
   * are present; see `sessionKey`.
   */
  hostId?: string;
  hostName?: string;
  /**
   * OPTIONAL, and the rail never receives one without it today.
   *
   * A session with no project is the Spool's master chat, and the sidebar is a
   * PROJECT-SCOPED list — the engine's project reads exclude it by construction,
   * so it never reaches this shape. The field is optional anyway because the
   * engine's `Session.projectId` is, and a type that disagreed with the protocol
   * would push a cast into whichever caller met one first.
   */
  projectId?: string;
  /** Resolved display name. Absent while the project list is still loading. */
  projectName?: string;
  /** `Project.icon` — the content-derived key behind the engine's icon route.
   *  Absent when the checkout carries no icon file. */
  projectIcon?: string;
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
  /** When the last turn ended, and whether it ended badly — the two facts the
   *  early-wake rule is made of. See `settlingActivity`. */
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
};

/** The engine record, flattened into what the rail actually reads. */
export function toSidebarSession(
  session: Session,
  projectName?: string,
  projectBranch?: string,
  projectIcon?: string,
  host?: { id: string; name: string },
): SidebarSession {
  return {
    id: session.id,
    title: session.title,
    ...(host ? { hostId: host.id, hostName: host.name } : {}),
    projectId: session.projectId,
    ...(projectName ? { projectName } : {}),
    ...(projectBranch ? { projectBranch } : {}),
    ...(projectIcon ? { projectIcon } : {}),
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
    ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
    ...(session.lastTurnFailed ? { lastTurnFailed: true } : {}),
  };
}

/**
 * The engine's four-state `activity` and its last-turn stamp, folded into the
 * four questions the settling rules actually ask.
 *
 * ONE PLACE, because both the list and the row need it and they must not answer
 * differently: a row whose Snooze button is enabled while the list would refuse
 * to hide it is a control that does nothing. `session-row.tsx` had its own
 * two-field version of this, which is exactly how that drift starts.
 *
 * `queued` COUNTS AS WORKING. It is not running yet, but a turn is on its way,
 * and settling a session that is about to answer you is the same mistake as
 * settling one mid-answer.
 */
export function settlingActivity(session: SidebarSession): SettlingActivity {
  return {
    working: session.activity === "working" || session.activity === "queued",
    waitingOnYou: session.activity === "blocked",
    ...(session.lastTurnEndedAt === undefined ? {} : { lastTurnEndedAt: session.lastTurnEndedAt }),
    // A failure is dated by when the turn ended, because that IS when it
    // failed — the engine derives both from the same turn.
    ...(session.lastTurnFailed ? { failed: true, ...(session.lastTurnEndedAt === undefined ? {} : { failedAt: session.lastTurnEndedAt }) } : {}),
  };
}

export type SessionBand = "pinned" | "active" | "snoozed" | "settled";

export type SessionListInput = {
  sessions: readonly SidebarSession[];
  projectId?: string;
  query?: string;
  activeSessionId?: string;
  now?: number;
  /** `null` turns the inactivity clock off. Comes from the engine — one answer
   *  per machine, not per browser. See `InboxPolicy`. */
  autoSettleAfterHours?: number | null;
  limit?: number;
  settledLimit?: number;
};

export type SessionListResult = {
  /** Fixed at the top, unpaged, and outside `sessions` so the rail can rule a
   *  line under it. */
  pinned: SidebarSession[];
  sessions: SidebarSession[];
  snoozed: SidebarSession[];
  snoozedCount: number;
  settled: SidebarSession[];
  settledCount: number;
  hasMoreSessions: boolean;
  hasMoreSettled: boolean;
  /** True when the result is a flat, shelf-less view — i.e. a search. */
  flat: boolean;
};

const createdNewestFirst = (a: SidebarSession, b: SidebarSession) =>
  b.createdAt - a.createdAt || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * Which band a row belongs to, in the precedence order stated at the top of
 * this file.
 *
 * ACTIVITY IS NO LONGER MISSING, and that was the whole limitation this comment
 * used to describe. The engine derives what each session is doing on the list
 * read (`Session.activity`), so a row that is blocked or running is classified
 * on what it is actually doing rather than on its stored fields alone — which
 * is what makes "a blocker beats every pin" true here and not just in the rules
 * module.
 */
export function bandOf(session: SidebarSession, options: SettlingOptions): SessionBand {
  const activity = settlingActivity(session);
  if (isSnoozed(session, activity, options)) return "snoozed";
  // The pin, checked after the snooze and before the clock. `isSettled` already
  // answers false for it; naming it here is what gives it a band of its own.
  if (session.settledOverride === "active") return "pinned";
  return isSettled(session, activity, options) ? "settled" : "active";
}

/** A session's identity across every Mac in the rail: two engines can mint
 *  the same id, so the host rides in front. Local sessions keep their bare
 *  id, which is what every URL and every existing comparison already uses. */
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

/** Pure derivation for the sidebar's session scope. */
export function deriveSessionList({
  sessions,
  projectId,
  query = "",
  activeSessionId,
  now = Date.now(),
  autoSettleAfterHours = DEFAULT_AUTO_SETTLE_HOURS,
  limit = SESSION_PAGE_SIZE,
  settledLimit = limit,
}: SessionListInput): SessionListResult {
  const options: SettlingOptions = { now, autoSettleAfterHours };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const eligible = sessions
    .filter((session) => !projectId || session.projectId === projectId)
    .filter((session) => {
      if (!normalizedQuery) return true;
      return `${session.title} ${session.projectName ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort(createdNewestFirst);

  // Search deliberately flattens every band. It is a transient command-like view
  // and should be able to recover a snoozed or settled session immediately —
  // which is also the only way to reach a snoozed row without waiting for it.
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
    const band = bandOf(session, options);
    (band === "pinned" ? pinned : band === "snoozed" ? snoozed : band === "settled" ? settled : current).push(session);
  }

  // An open SNOOZED session moves into the live band while you are reading it —
  // its shelf is collapsed and time-sorted, so leaving it there strands you.
  //
  // A SETTLED ONE STAYS SETTLED. The survivor rule used to promote it too, and
  // that read as a bug: clicking a settled row pushed it back to the top of the
  // list, undoing the settle nobody asked to undo. Settled is a decision (or an
  // aged-out fact), and merely READING a session is neither — the row stays on
  // its shelf, highlighted there, until the person presses "Return to the list".
  const activeSnoozed = activeSessionId ? snoozed.find((session) => sessionKey(session) === activeSessionId) : undefined;
  const currentWithSurvivor = activeSnoozed ? [...current, activeSnoozed].sort(createdNewestFirst) : current;
  const snoozedRest = activeSnoozed ? snoozed.filter((session) => sessionKey(session) !== sessionKey(activeSnoozed)) : snoozed;

  const currentPage = pageWithActive(currentWithSurvivor, limit, activeSessionId);
  // `activeSessionId` threaded so the settled row you are READING stays on the
  // visible page of its own shelf instead of vanishing behind "Show more".
  const settledPage = pageWithActive(settled, settledLimit, activeSessionId);

  return {
    // NOT PAGED. You chose every row in this band by hand, so there is nothing
    // here you did not ask to see — and a "Show more" under six pinned rows
    // would be chrome guarding against a list you built yourself.
    pinned,
    sessions: currentPage.rows,
    // SOONEST WAKE FIRST, which is the only question this shelf answers: what
    // comes back next. Everywhere else sorts by recency; here recency is the
    // wrong end of the session.
    snoozed: snoozedRest.slice().sort((left, right) => (left.snoozedUntil ?? 0) - (right.snoozedUntil ?? 0)),
    snoozedCount: snoozedRest.length,
    settled: settledPage.rows,
    settledCount: settled.length,
    hasMoreSessions: currentPage.hasMore,
    hasMoreSettled: settledPage.hasMore,
    flat: false,
  };
}

/**
 * What ⌘1..⌘9 index into: the rail's own rows, TOP TO BOTTOM, as drawn.
 *
 * PINNED FIRST, THEN THE LIST, because that is the order on screen — and the
 * whole value of a positional shortcut is that you can predict it without
 * looking. The donor indexed its single "Recent" band; the rail has a band above
 * that one now, and a ⌘1 that skipped the row sitting at the top would be a
 * shortcut you have to check before using.
 *
 * SHELVES ARE EXCLUDED. Snoozed and settled rows are, by definition, ones you
 * said you did not want in front of you; a number key is for the rows that are.
 *
 * Reuses `deriveSessionList` rather than re-sorting, so this can never drift
 * from what the rail renders. `activeSessionId` is threaded through for the same
 * reason the rail passes it — but the survivor pin can land the open session
 * anywhere on the page, which is meaningless for INDEXING, so the slice is what
 * guards the bound.
 */
export function recentSessionsForCommandKeys(
  sessions: readonly SidebarSession[],
  activeSessionId?: string,
  now = Date.now(),
  autoSettleAfterHours: number | null = DEFAULT_AUTO_SETTLE_HOURS,
): SidebarSession[] {
  const list = deriveSessionList({
    sessions,
    ...(activeSessionId ? { activeSessionId } : {}),
    now,
    autoSettleAfterHours,
    limit: 9,
  });
  return [...list.pinned, ...list.sessions].slice(0, 9);
}

/** The route a session's own row links to — spelled once so every caller
 *  resolves to the exact same URL a click on the row would. */
export function sessionHref(session: Pick<SidebarSession, "id" | "projectId" | "hostId">): string {
  // A SESSION WITH NO PROJECT IS THE SPOOL'S MASTER CHAT, and its address is the
  // Spool itself — there is no `/projects/<id>/...` URL to build for it, and
  // composing one with `undefined` in the path would 404 in a way that looks
  // like a routing bug rather than a session that lives somewhere else.
  if (!session.projectId) return "/spool";
  return `${hostPrefix(session.hostId)}/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`;
}

/**
 * The new-conversation canvas for a project — spelled once for the same reason
 * `sessionHref` is, and with a sharper edge: the cockpit now decides whether it
 * is showing a canvas or a session by COMPARING the pathname to this string, so
 * a second spelling anywhere would be a screen that never resets.
 */
export function canvasHref(projectId: string, hostId?: string): string {
  return `${hostPrefix(hostId)}/projects/${encodeURIComponent(projectId)}/sessions/new`;
}

/**
 * Which session is open — on whichever Mac. Answers the same `sessionKey` a
 * row carries, so a remote session you are reading is matched against its
 * own host and not against a local session that happens to share the id.
 */
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

/**
 * Which project's CANVAS is open, if a canvas is open at all.
 *
 * `activeSessionFromPathname` answers `"new"` here — a literal that matches no
 * session id, which is exactly right for the session list and useless for the
 * draft rail, where the open canvas IS one of the rows and has to be able to
 * show it. Reads the project half instead, and only on the canvas route: on a
 * session route the draft rows are all elsewhere and none of them is current.
 */
export function canvasProjectFromPathname(pathname: string): string | undefined {
  const match = /^(?:\/hosts\/[^/]+)?\/projects\/([^/]+)\/sessions\/new\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
