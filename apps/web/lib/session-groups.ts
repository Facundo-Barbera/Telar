/**
 * The Work surface rail's arrangement of the live list: attention first,
 * pinned next, then the remaining active rows grouped by project.
 *
 * Pure. Takes `deriveSessionList`'s output so paging, search, scope, the
 * survivor rule and the shelves stay exactly the classic rail's. Every session
 * appears once: a blocked row lives in `attention` and nowhere else, a pinned
 * one in `pinned`, everything else under its project.
 *
 * WHERE A GROUP SITS IS A DECISION, NOT A SIDE EFFECT. The groups used to come
 * out in the order their newest conversation was created, so starting one
 * hoisted its project to the top and every other group shifted under the
 * pointer — the one thing a list you navigate by position must not do. Now a
 * group sits where the reader dragged it (`SidebarLayout.projectOrder`, on the
 * engine), and a group nobody has placed falls in after the placed ones,
 * alphabetically. Nothing about a conversation moves its project.
 *
 * AND SO IS WHERE A ROW SITS INSIDE ONE. `SidebarLayout.sessionOrder` (per
 * group) and `pinnedOrder` (the band) are the same decision one level down: a
 * row the reader has placed sits there, an unplaced one falls in after the
 * placed ones in the recency order this list already produced. A row moves
 * within its own band only — carrying a conversation into another project is a
 * different verb, with a worktree behind it.
 */
import { useCallback, useEffect, useState } from "react";
import type { ProjectAvailability } from "@telar/engine-client";
import { sessionKey, type SidebarSession, type SessionListResult } from "./session-list";

const COLLAPSED_KEY = "telar:sidebar-collapsed-groups";

/**
 * THE FOUR FOLD MOVES, AS SET MATH RATHER THAN AS A HOOK.
 *
 * `toggle` was the only one until the project header and the rail's empty space
 * grew menus; the three that landed with them — collapse others, collapse all,
 * expand all — are the same shape, so they are spelled here as pure transitions
 * on the fold set and the hook below merely persists whatever they return.
 *
 * THEY TAKE THE DRAWN KEYS, NEVER A STORED LIST. "Collapse all" means the groups
 * on screen: a fold set carrying a key for a paired Mac that is away, or for a
 * project with nothing live, would claim to have folded rows nobody can see —
 * and would un-fold them the day that Mac answered again. Keys already in the
 * set that are not drawn are kept for exactly that reason: they are somebody
 * else's fold, not this gesture's to clear.
 */
export function foldedAfter(
  current: ReadonlySet<string>,
  drawn: readonly string[],
  move: { kind: "toggle" | "others"; key: string } | { kind: "all" | "none" },
): Set<string> {
  const next = new Set(current);
  if (move.kind === "toggle") {
    if (next.has(move.key)) next.delete(move.key);
    else next.add(move.key);
    return next;
  }
  if (move.kind === "others") {
    for (const key of drawn) if (key !== move.key) next.add(key);
    next.delete(move.key);
    return next;
  }
  for (const key of drawn) {
    if (move.kind === "all") next.add(key);
    else next.delete(key);
  }
  return next;
}

export type CollapsedGroups = {
  collapsed: Set<string>;
  toggle: (key: string) => void;
  /** Fold every drawn group but this one — the lobby's own verb, same name. */
  collapseOthers: (key: string, drawn: readonly string[]) => void;
  collapseAll: (drawn: readonly string[]) => void;
  expandAll: (drawn: readonly string[]) => void;
};

/** Which project groups are folded, by host-qualified key, persisted per client. */
export function useCollapsedGroups(): CollapsedGroups {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const task = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) setCollapsed(new Set(parsed.filter((key): key is string => typeof key === "string")));
      } catch {
        // Unreadable store: every group starts open.
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, []);
  const apply = useCallback((move: Parameters<typeof foldedAfter>[2], drawn: readonly string[] = []) => {
    setCollapsed((current) => {
      const next = foldedAfter(current, drawn, move);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Quota or private mode: the fold lives for this page only.
      }
      return next;
    });
  }, []);
  return {
    collapsed,
    toggle: useCallback((key: string) => apply({ kind: "toggle", key }), [apply]),
    collapseOthers: useCallback((key: string, drawn: readonly string[]) => apply({ kind: "others", key }, drawn), [apply]),
    collapseAll: useCallback((drawn: readonly string[]) => apply({ kind: "all" }, drawn), [apply]),
    expandAll: useCallback((drawn: readonly string[]) => apply({ kind: "none" }, drawn), [apply]),
  };
}

export type ProjectGroup = {
  /** Host-qualified, because two Macs can register the same project id. */
  key: string;
  projectId: string;
  hostId?: string;
  name: string;
  icon?: string;
  /** The glyph somebody picked, which outranks `icon` — see `ProjectAvatar`. */
  iconName?: string;
  hostName?: string;
  /**
   * THE DRIVE THIS GROUP'S WORK IS ON, WHEN IT IS NOT HERE — issue #534.
   *
   * ONLY WHEN EVERY PLACE AGREES, and that is the whole rule. A group can span
   * two Macs (one repository, two checkouts — see `projectGroupKey`), and if the
   * drive is plugged into one of them the work is reachable: a header badge
   * saying otherwise would be false for half the rows under it. So this is set
   * only when NO registration in the group can be read, which is also the case
   * that is nearly always a single Mac with a cable out.
   *
   * Absent means available, or not yet known — an engine that predates the
   * field, or a list still loading. Both draw exactly what they always did.
   */
  availability?: Exclude<ProjectAvailability, "available">;
  /**
   * EVERY CONVERSATION THIS PROJECT HOLDS, and no row is held back — issue
   * #381. A pinned coordinator used to claim the rows it followed and this
   * group gave them up (`withholdFollowedRows`), paying for it with a
   * "+N following" chip. Both halves are gone with the tree that needed them:
   * a delegated conversation is a conversation, and it draws where it lives.
   */
  sessions: SidebarSession[];
};

/**
 * What a whole group's rows agree the disk is doing, or nothing.
 *
 * One row with no answer is enough to say nothing: "not yet known" is not
 * evidence that a drive is away, and a badge that flickered on during the first
 * load of every rail would be worse than no badge.
 */
function groupAvailability(sessions: readonly SidebarSession[]): Exclude<ProjectAvailability, "available"> | undefined {
  let agreed: Exclude<ProjectAvailability, "available"> | undefined;
  for (const session of sessions) {
    const state = session.projectAvailability;
    if (state === undefined || state === "available") return undefined;
    if (agreed !== undefined && agreed !== state) return undefined;
    agreed = state;
  }
  return agreed;
}

export type GroupedSessions = {
  attention: SidebarSession[];
  pinned: SidebarSession[];
  groups: ProjectGroup[];
};

/**
 * WHICH GROUP A ROW BELONGS TO — the repository it is work on, when the row can
 * name one, and otherwise this Mac's registration of it.
 *
 * TWO MACS' CHECKOUTS OF ONE REPOSITORY ARE ONE PROJECT, because that is what
 * they are to the person looking at them: the same code, the same branches, the
 * same work, on two machines. Keyed by host and project id they were two groups
 * with one name, distinguishable only by a badge, and the reader had to
 * remember which Mac they had last started something on to find the
 * conversation they wanted. `Project.remoteUrl` is the only fact a row carries
 * that is true on both — the project IDS are minted per engine and the NAMES
 * are whatever each person typed — so it is what the fold is made of.
 *
 * A ROW THAT CANNOT NAME A REPOSITORY KEEPS THE OLD KEY, and that is the
 * important half. A project with no origin, an unversioned directory, a Mac
 * still loading its project list: `hostId:projectId` groups those exactly as
 * before, one group per registration. Folding two originless projects on their
 * NAME would merge two unrelated folders that happen to be called `scratch`,
 * which is a worse failure than the one this fixes — so the absence of an
 * answer is never treated as an answer.
 *
 * The `repo:` prefix is not decoration: a normalised remote is `host/owner/repo`
 * and a host-qualified key is `hostId:projectId`, and without it a host called
 * `github.com` with a project id `owner/repo` would collide with the repository
 * of that name.
 */
export function projectGroupKey(session: Pick<SidebarSession, "projectId" | "hostId" | "projectRemote">): string {
  if (session.projectRemote) return `repo:${session.projectRemote}`;
  return session.hostId ? `${session.hostId}:${session.projectId ?? ""}` : (session.projectId ?? "");
}

/**
 * THE SAME MAC, READ TWICE, DRAWS ONCE.
 *
 * A paired host can be THIS cockpit's own engine — its own pairing link pasted
 * back in, or the desktop shell opened against a Mac that is also in its book
 * — and two hosts in the book can be one Mac under two addresses before the
 * merge in `hosts/book.ts` has had a daemon id to merge on. Every session then
 * arrives twice with two keys, and the rail draws two groups with one name and
 * the same rows, which is the "sessions duplicate" report.
 *
 * `daemonId` is the engine's own identity for its current run, and every read
 * carries it. Rows are folded by (daemonId, session id): the LOCAL read wins,
 * because its rows open without a hop; between two remotes the first in book
 * order wins. Rows from a read that could not name its engine are kept as
 * they are — a Mac that did not say cannot be proven to be another.
 */
export function dedupeAcrossHosts<T extends Pick<SidebarSession, "id" | "hostId">>(
  reads: readonly { daemonId?: string; sessions: readonly T[] }[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const read of reads) {
    for (const session of read.sessions) {
      if (read.daemonId) {
        const key = `${read.daemonId}:${session.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(session);
    }
  }
  return out;
}

/** Blocked is the engine's own "waiting on you" — the only attention state the rail can honestly claim. */
export function needsAttention(session: SidebarSession): boolean {
  return session.activity === "blocked";
}

/** The drag's own type, so a file or a reference dropped on a group header is
 *  not mistaken for a group. Vendor-prefixed per RFC 6839, like `REFERENCE_MIME`. */
export const PROJECT_GROUP_MIME = "application/x-telar-project-group";

/**
 * A ROW'S OWN DRAG TYPE, AND THAT IT IS A SECOND TYPE IS THE POINT. A row
 * carried over a project header must not look like a group being dropped there
 * — moving a conversation between projects is a different verb, with a
 * worktree behind it — so the two gestures cannot be confused by a drop
 * handler that only asked "is something being dragged".
 */
export const SESSION_ROW_MIME = "application/x-telar-session-row";

/**
 * THE SCOPE A ROW DRAG IS CONFINED TO: one project group, by key, or the pinned
 * band. Carried beside the row's own key so a drop target can refuse a row from
 * somewhere else without having to look the row up.
 */
export const PINNED_ROW_SCOPE = "pinned";

/**
 * Place the groups: the ones the reader has arranged first, in that order,
 * then the rest alphabetically. Two groups with one name — the same project
 * registered on this Mac and a paired one — put this Mac's first, so the copy
 * that says where it lives is the one wearing the badge.
 */
export function orderProjectGroups(groups: readonly ProjectGroup[], order: readonly string[] = []): ProjectGroup[] {
  const rank = new Map(order.map((key, index) => [key, index] as const));
  return [...groups].sort((left, right) => {
    const leftRank = rank.get(left.key);
    const rightRank = rank.get(right.key);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      Number(Boolean(left.hostId)) - Number(Boolean(right.hostId)) ||
      (left.hostName ?? "").localeCompare(right.hostName ?? "") ||
      left.key.localeCompare(right.key)
    );
  });
}

/**
 * The order after a drop: `dragged` lands above or below `target` in the list
 * as DRAWN, and the whole drawn list is what gets written — so every group on
 * screen keeps the place it had, not only the one that moved. A group drawn
 * for the first time is thereby placed too, which is what stops it drifting
 * once somebody has arranged anything.
 *
 * KEYS THE RAIL IS NOT DRAWING RIGHT NOW — a paired Mac that is away, a project
 * with nothing live — keep their slot relative to the ones it is, rather than
 * being pruned by a drag that had nothing to do with them.
 */
export function moveProjectGroup(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  return movedOrder(stored, drawn, dragged, target, position);
}

/**
 * THE MOVE ITSELF, over bare keys — shared by the group drag above and the row
 * drag below, which are the same arithmetic on two different lists. Spelled
 * once so a row drop and a group drop cannot come to disagree about what
 * "above" means, or about which unseen keys survive a write.
 */
function movedOrder(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  const without = drawn.filter((key) => key !== dragged);
  const anchor = without.indexOf(target);
  if (dragged === target || anchor < 0 || !drawn.includes(dragged)) return [...drawn];
  const at = anchor + (position === "below" ? 1 : 0);
  const next = [...without.slice(0, at), dragged, ...without.slice(at)];
  let after = -1;
  for (const key of stored) {
    const index = next.indexOf(key);
    if (index >= 0) {
      after = index;
      continue;
    }
    next.splice(after + 1, 0, key);
    after += 1;
  }
  return next;
}

/**
 * The order of the ROWS inside one band after a drop — a project group's rows,
 * or the pinned band's.
 *
 * THE SAME WRITE THE GROUP DRAG MAKES, deliberately: the whole drawn list is
 * returned, so every row on screen keeps the place it had and a row nobody had
 * placed is placed by this drop rather than left to drift back up the list the
 * next time something happens to it. Rows the rail is not drawing — a later
 * page of a long project, a row filtered out by scope — keep their slot
 * relative to the ones it is.
 *
 * ONE BAND AT A TIME, AND THAT IS ENFORCED BY WHAT THIS TAKES. It is handed one
 * band's drawn keys; a row dropped on a different group is not in them, the
 * anchor is not found, and the drawn order comes back unchanged. Moving a
 * conversation between projects is a different verb with a worktree behind it.
 */
export function moveSessionRow(
  stored: readonly string[],
  drawn: readonly string[],
  dragged: string,
  target: string,
  position: "above" | "below",
): string[] {
  return movedOrder(stored, drawn, dragged, target, position);
}

/**
 * Place the rows: the ones the reader has arranged first, in that order, then
 * the rest in the order they arrived — which is the rail's existing recency
 * sort, untouched.
 *
 * A STABLE SORT IS NOT ENOUGH ON ITS OWN, so this partitions rather than sorts:
 * a comparator would have to answer "which of two unplaced rows comes first",
 * and the only correct answer is "whichever `deriveSessionList` already put
 * first", which a comparator cannot see.
 */
export function orderSessions<T extends Pick<SidebarSession, "id" | "hostId">>(
  sessions: readonly T[],
  order: readonly string[] = [],
): T[] {
  if (order.length === 0) return [...sessions];
  const rank = new Map(order.map((key, index) => [key, index] as const));
  const placed: { at: number; session: T }[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    const at = rank.get(sessionKey(session));
    if (at === undefined) rest.push(session);
    else placed.push({ at, session });
  }
  placed.sort((left, right) => left.at - right.at);
  return [...placed.map((entry) => entry.session), ...rest];
}

/**
 * ONE PLACE UP, OR ONE PLACE DOWN — the project header menu's own verb, and
 * THE SAME WRITE THE DRAG MAKES. It resolves the neighbour in the DRAWN order
 * and hands both to `moveProjectGroup`, so a keyboard-only reorder and a drop
 * cannot disagree about what "above" means or about which keys get written.
 *
 * `undefined` AT EITHER END, rather than the list unchanged. A menu row has to
 * decide whether to offer itself before anybody presses it, and "there is
 * nowhere to go" is the answer to that question as well as to this one — so the
 * caller disables the row on the same value it would have written.
 */
export function moveProjectGroupStep(
  stored: readonly string[],
  drawn: readonly string[],
  key: string,
  direction: "up" | "down",
): string[] | undefined {
  const at = drawn.indexOf(key);
  if (at < 0) return undefined;
  const neighbour = drawn[direction === "up" ? at - 1 : at + 1];
  if (neighbour === undefined) return undefined;
  return moveProjectGroup(stored, drawn, key, neighbour, direction === "up" ? "above" : "below");
}

/**
 * The arrangement of the ROWS, as the engine holds it: one list per project
 * group key, plus the pinned band's own. Optional at every level — a rail whose
 * engine has not answered yet, or whose reader has never dragged a row, draws
 * exactly the recency order it always did.
 */
export type SessionOrders = {
  sessions?: Readonly<Record<string, readonly string[]>>;
  pinned?: readonly string[];
};

export function groupSessions(
  list: Pick<SessionListResult, "pinned" | "sessions">,
  order: readonly string[] = [],
  rows: SessionOrders = {},
): GroupedSessions {
  const attention: SidebarSession[] = [];
  const pinned: SidebarSession[] = [];
  const groups = new Map<string, ProjectGroup>();
  const seen = new Set<string>();

  const place = (session: SidebarSession, isPinned: boolean) => {
    const id = sessionKey(session);
    if (seen.has(id)) return;
    seen.add(id);
    if (needsAttention(session)) return attention.push(session);
    if (isPinned) return pinned.push(session);
    if (!session.projectId) return; // A project-less row is not one of these groups.
    const key = projectGroupKey(session);
    const group = groups.get(key) ?? {
      key,
      projectId: session.projectId,
      ...(session.hostId ? { hostId: session.hostId } : {}),
      ...(session.hostName ? { hostName: session.hostName } : {}),
      name: session.projectName ?? session.projectId,
      ...(session.projectIcon ? { icon: session.projectIcon } : {}),
      ...(session.projectIconName ? { iconName: session.projectIconName } : {}),
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  };

  for (const session of list.pinned) place(session, true);
  for (const session of list.sessions) place(session, false);

  /**
   * ATTENTION IS NOT ARRANGED, and that is a decision rather than an omission.
   * "Needs you" is a queue the engine fills, not a shelf you keep — a row leaves
   * it by being answered — so a place dragged into it would be a place for a row
   * that is about to disappear.
   */
  return {
    attention,
    pinned: orderSessions(pinned, rows.pinned),
    groups: orderProjectGroups([...groups.values()], order).map((group) => {
      // Folded here rather than when the group is first created: the answer is
      // about ALL of its rows, and the last of them arrives after the first.
      const availability = groupAvailability(group.sessions);
      return {
        ...group,
        ...(availability ? { availability } : {}),
        sessions: orderSessions(group.sessions, rows.sessions?.[group.key]),
      };
    }),
  };
}

/**
 * What ⌘1..⌘9 index into: the rail's own rows, TOP TO BOTTOM, AS DRAWN.
 *
 * The whole value of a positional shortcut is that you can predict it without
 * looking, and the only order a reader can predict is the one on screen. So
 * this walks the rail the way the eye does: the "Needs you" band, then pinned,
 * then each project group in its arranged order — skipping a group that is
 * folded, because a number on a row you cannot see is a number you cannot
 * check. It used to count the flat list by creation time, which was the order
 * on screen right up until the groups landed and then quietly was not.
 *
 * SHELVES ARE EXCLUDED. Snoozed and settled rows are, by definition, ones you
 * said you did not want in front of you; a number key is for the rows that are.
 *
 * Takes the rail's OWN `groupSessions` output rather than re-deriving it, so
 * this cannot drift from what is rendered: the same scope, the same page, the
 * same arranged groups, the same folds. (A search flattens the rail; the
 * caller hands over the flat result list instead.)
 */
export function railRowsForCommandKeys(grouped: GroupedSessions, collapsed?: ReadonlySet<string>): SidebarSession[] {
  const rows = [...grouped.attention, ...grouped.pinned];
  for (const group of grouped.groups) {
    if (!collapsed?.has(group.key)) rows.push(...group.sessions);
  }
  return rows.slice(0, 9);
}

/** The nine numbers, as a type: a slot is 1-9 or there is no slot, and spelling
 *  it this way is what makes `` `jump-${slot}` `` a `CommandId` with no cast. */
export const RAIL_JUMP_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type RailJumpSlot = (typeof RAIL_JUMP_SLOTS)[number];

/**
 * WHICH NUMBER EACH ROW WEARS while ⌘ is held — issue #401.
 *
 * Keyed by `sessionKey`, off the SAME array `useCommandKeys` is handed, so the
 * hint on a row and the key that fires cannot disagree: if one of them counts a
 * folded group or a shelf, both do. That is the whole reason this takes rows
 * rather than re-walking the groups — a second walk is a second chance to be
 * wrong about what is on screen.
 */
export function railJumpSlots(rows: readonly SidebarSession[]): Map<string, RailJumpSlot> {
  const slots = new Map<string, RailJumpSlot>();
  rows.forEach((session, index) => {
    const slot = RAIL_JUMP_SLOTS[index];
    if (slot !== undefined) slots.set(sessionKey(session), slot);
  });
  return slots;
}
