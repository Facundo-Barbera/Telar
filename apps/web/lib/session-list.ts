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
 * UNREAD IS NO LONGER ABSENT EITHER, and it is engine-owned for the same
 * reason the snooze is: the receipt is written when a human is actually shown
 * a result (`markSessionRead`), so it survives a reload and agrees across
 * devices. What it buys the list is one rule — the inactivity clock may not
 * shelve a session whose newest answer nobody has read.
 *
 * Everything else here is the donor's logic verbatim: the same sort, the same
 * "search flattens every band", the same survivor rule that keeps the session
 * you are LOOKING AT visible after it drops into a shelf.
 */
import {
  DEFAULT_AUTO_SETTLE_HOURS,
  type LiveSessionRow,
  type SessionActivity,
  type SessionAssignment,
  type SessionSettledBy,
} from "@telar/engine-client";
import { isShelved, isSnoozed, settlingActivityOf, type SettlingActivity, type SettlingOptions } from "./session-settling";
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
  draft?: boolean;
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
   * Who this session is working for, and what it has finished for them.
   *
   * FROM THE LIVE LIST, not a per-row history read — the engine folds these
   * over each session's whole queue and sends them on `liveSessions()`. The
   * sidebar polls that one route, so learning this costs no extra request.
   */
  assignments?: readonly SessionAssignment[];
  /** Which session started this one. Provenance, never a lifetime. */
  startedFrom?: { sessionId: string; runId?: string };
  /**
   * OPTIONAL, and the rail never receives one without it today.
   *
   * The sidebar is a PROJECT-SCOPED list and a session with no project is not a
   * row in it — the engine's project reads exclude it by construction,
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
  /** `Project.iconName` — the glyph somebody PICKED, which outranks the file
   *  above. Two fields because they are two questions; `ProjectAvatar` is what
   *  prefers one, so no row here has to know which kind of answer it got. */
  projectIconName?: string;
  /**
   * `Project.remoteUrl` — which REPOSITORY this row's project is a checkout of,
   * as `host/owner/repo`. The one fact a row carries that is true on more than
   * one Mac, and therefore the one thing two Macs' registrations of the same
   * work can be recognised by; see `projectGroupKey`.
   *
   * Absent on a project with no origin, on an unversioned directory, and while
   * the project list is still loading.
   */
  projectRemote?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  driver: "claude" | "codex" | "opencode";
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
  /**
   * WHY THE ENGINE SHELVED IT, when it was not a person — issue #378. Present
   * only alongside `settledOverride: "settled"`.
   */
  settledBy?: SessionSettledBy;
  /**
   * The coordinator's title, resolved ONCE by the rail off the list it already
   * has. A row cannot look it up: a projection that went hunting for another
   * session would be a read per row per render, and the stamp carries an id
   * because ids are what survive a rename.
   *
   * ABSENT IS ORDINARY — the coordinator may have been archived since, and
   * `liveSessions` does not carry archived rows. The hint then says what
   * happened without naming anybody, which is better than a raw id.
   */
  settledForTitle?: string;
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
  /** Is there an answer here nobody has read — see `hasUnreadResult`. Carried
   *  on the projection like the rest of the inbox state, because `bandOf` runs
   *  per row per render and must not go looking anything up. */
  lastTurnSequence?: number;
  lastReadTurnSequence?: number;
  readAt?: number;
  /** When the last turn ended, and whether it ended badly — the two facts the
   *  early-wake rule is made of. See `settlingActivity`. */
  lastTurnEndedAt?: number;
  lastTurnFailed?: boolean;
  /**
   * WHEN THIS ROW WAS LAST READ FROM ITS HOST, and only on a row whose host has
   * since stopped answering — see `lib/sidebar-cache.ts`. A live row never
   * carries it, which is why `toSidebarSession` cannot produce one: it is a
   * fact about the READ, not about the session. The row dims itself and says so
   * on hover; the bands treat it like any other row, because a Mac being away
   * does not change what its sessions are doing.
   */
  stale?: number;
};

/**
 * The engine record, flattened into what the rail actually reads.
 *
 * TAKES A `LiveSessionRow`, WHICH IS THE WIDER TYPE (#459): the live route now
 * sends only the fields a row draws, and a whole `Session` is assignable to one
 * — so every caller that passes a full record still typechecks, and the one
 * that passes a row no longer has to invent the dozen keys it never read.
 */
export function toSidebarSession(
  session: LiveSessionRow,
  projectName?: string,
  projectBranch?: string,
  projectIcon?: string,
  host?: { id: string; name: string },
  assignments?: readonly SessionAssignment[],
  projectRemote?: string,
  projectIconName?: string,
  /** The title of the session named by `settledBy` — see `settledForTitle`. */
  coordinatorTitle?: string,
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
    ...(session.settledBy ? { settledBy: session.settledBy } : {}),
    ...(session.settledBy && coordinatorTitle ? { settledForTitle: coordinatorTitle } : {}),
    ...(session.snoozedUntil === undefined ? {} : { snoozedUntil: session.snoozedUntil }),
    ...(session.snoozedAt === undefined ? {} : { snoozedAt: session.snoozedAt }),
    activity: session.activity,
    ...(session.activityAt === undefined ? {} : { activityAt: session.activityAt }),
    ...(session.lastTurnSequence === undefined ? {} : { lastTurnSequence: session.lastTurnSequence }),
    ...(session.lastReadTurnSequence === undefined ? {} : { lastReadTurnSequence: session.lastReadTurnSequence }),
    ...(session.readAt === undefined ? {} : { readAt: session.readAt }),
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
 * NOW THE PROTOCOL'S, because the ENGINE folds it too (#457): it decides which
 * rows leave `GET /v2/sessions/live` at all, so a fold that lived only in the
 * cockpit would be half of a rule with the other half on the other side of the
 * wire. Kept as a named re-export here — it takes `SidebarSession`, which the
 * protocol cannot name, and every caller in this app says `settlingActivity`.
 */
export function settlingActivity(session: SidebarSession): SettlingActivity {
  return settlingActivityOf(session);
}

/**
 * WHY THIS ROW IS ON THE SHELF, in a sentence — issue #378.
 *
 * ONLY EVER FOR AN ENGINE SETTLE. A row a person shelved needs no explanation:
 * they were there. This is the one case where the reader did not make the
 * decision and would otherwise have to reconstruct it from an assignment list
 * and a clock.
 *
 * THE COORDINATOR IS NAMED WHEN IT CAN BE, and the sentence stands up without
 * it: an archived coordinator is not on the list the rail resolves titles from,
 * and "settled after its work for session_abc was delivered" would be worse
 * than not naming anyone.
 */
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
  /** `null` turns the inactivity clock off. Comes from the engine — one answer
   *  per machine, not per browser. See `InboxPolicy`. */
  autoSettleAfterHours?: number | null;
  /**
   * A PAIRED MAC'S ROWS ARE BANDED BY THAT MAC'S CLOCK. The settling window is
   * an engine's own document, so a row from the mini is shelved when the mini
   * would shelve it — not when this Mac would. Keyed by host id (`LOCAL_HOST`
   * for this engine); a host with no entry falls back to `autoSettleAfterHours`.
   */
  windowsByHost?: ReadonlyMap<string, number | null>;
  limit?: number;
  settledLimit?: number;
};

/** The settling window that applies to ONE row: its own Mac's, else the default. */
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
  // The shelf question, not the row question — and it is the PROTOCOL's now,
  // because the engine asks the same one to decide which rows leave
  // `/v2/sessions/live` at all (#457). The draft carve-out that used to sit
  // here is inside it; see `isShelved`.
  return isShelved(session, activity, options) ? "settled" : "active";
}

/** A session's identity across every Mac in the rail: two engines can mint
 *  the same id, so the host rides in front. Local sessions keep their bare
 *  id, which is what every URL and every existing comparison already uses. */
/**
 * Sessions doing work for `coordinatorId`, and sessions it started.
 *
 * TWO DIFFERENT RELATIONSHIPS, deliberately not merged. An assignment is
 * current work and ends; provenance is permanent and ends nothing. A session
 * that finished a task still belongs here — under `review` — because dropping
 * it the moment its run ended would hide the result the coordinator delegated
 * for.
 *
 * NOT A RAIL ARRANGEMENT ANY MORE — issue #381. This used to decide which rows
 * the sidebar indented under which, and with it came a rule about when a
 * delegate stopped being drawn there (`leavesRelatedWork`, #370/#372): a tree
 * that never let go claimed outstanding work where there was none. The rail
 * draws every conversation in its own band now, so the fold has one reader
 * left — the panel's Agents surface, which is a ROSTER. A roster wants the
 * whole record, including the errand that finished last week and says so, and
 * there is nothing for a clock to decide.
 *
 * KEYED THROUGH `sessionKey`, because two Macs can mint the same session id and
 * a coordinator on one host must not gather a stranger from another.
 */
export type RelatedWork = {
  /** Outstanding assignments from this coordinator. */
  active: SidebarSession[];
  /** Finished — the result the coordinator delegated for. */
  review: SidebarSession[];
  /** Started from this coordinator, with no current assignment. */
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
    // SAME HOST ONLY. `sessionKey` scopes the comparison; an assignment's
    // `fromSessionId` is a bare id, which is only meaningful within one engine.
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

/** Pure derivation for the sidebar's session scope. */
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
}: SessionListInput): SessionListResult {
  const optionsFor = (session: SidebarSession): SettlingOptions => ({ now, autoSettleAfterHours: windowFor(session, autoSettleAfterHours, windowsByHost) });
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
    const band = bandOf(session, optionsFor(session));
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

// What ⌘1..⌘9 index into moved to `session-groups.ts` (`railRowsForCommandKeys`):
// the rail draws its rows grouped by project now, and the shortcut has to walk
// the same arrangement the eye does.

/** The route a session's own row links to — spelled once so every caller
 *  resolves to the exact same URL a click on the row would. */
export function sessionHref(session: Pick<SidebarSession, "id" | "projectId" | "hostId">): string {
  // A SESSION WITH NO PROJECT HAS NO PROJECT-SCOPED ADDRESS, so it gets the
  // front door: there is no `/projects/<id>/...` URL to build for it, and
  // composing one with `undefined` in the path would 404 in a way that looks
  // like a routing bug rather than a session that lives nowhere in this list.
  if (!session.projectId) return "/";
  return `${hostPrefix(session.hostId)}/projects/${encodeURIComponent(session.projectId)}/sessions/${encodeURIComponent(session.id)}`;
}

/**
 * The new-conversation canvas for a project — spelled once for the same reason
 * `sessionHref` is, and with a sharper edge: the cockpit now decides whether it
 * is showing a canvas or a session by COMPARING the pathname to this string, so
 * a second spelling anywhere would be a screen that never resets.
 */
export function canvasHref(projectId: string, hostId?: string, options?: { baseRef?: string }): string {
  const canvas = `${hostPrefix(hostId)}/projects/${encodeURIComponent(projectId)}/sessions/new`;
  /**
   * THE BASE RIDES AS A QUERY, NOT AS A PATH SEGMENT, and that is what keeps
   * the sentence above true: the cockpit decides canvas-or-session by comparing
   * `usePathname()` to this string, and a pathname carries no query — so
   * `?base=…` cannot make a canvas stop recognising itself.
   *
   * It exists for the session menu's "New session on <branch>", which promises
   * the new worktree is cut from where this session works. Without carrying the
   * ref the label would name a branch the canvas then ignored, which is the one
   * thing a menu item that names a branch must not do.
   */
  return options?.baseRef ? `${canvas}?base=${encodeURIComponent(options.baseRef)}` : canvas;
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
