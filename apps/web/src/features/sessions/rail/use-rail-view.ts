import { useExpandedParents, flatRailRows, flattenSessions } from "@/lib/flat-rail";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { appliedProjectFilter, filterSessionsToProjects, projectFilterKey, useProjectFilter } from "@/lib/project-filter";
import {
  groupSessions,
  moveProjectGroupStep,
  PINNED_ROW_SCOPE,
  RAIL_JUMP_SLOTS,
  railJumpSlots,
  railRowsForCommandKeys,
  useCollapsedGroups,
} from "@/lib/session-groups";
import { bandOf, deriveSessionList, sessionKey, windowFor, type SidebarSession } from "@/lib/session-list";
import { useSidebarLayout } from "@/lib/sidebar-layout";
import type { RowEnv } from "./rail-parts";
import type { RailData } from "./use-rail-data";
import { useRailDrag } from "./use-rail-drag";

type ViewInput = { query: string; activeSessionId: string | undefined; sessionLimit: number; settledLimit: number };

/** What the rail draws from the data: the filtered list, its grouping, drag and jump slots. */
export function useRailView(data: RailData, { query, activeSessionId, sessionLimit, settledLimit }: ViewInput) {
  const { policy } = useInboxPolicy();
  const autoSettleAfterHours = policy.autoSettleAfterHours;
  const collapsed = useCollapsedGroups();
  const projectFilter = useProjectFilter();
  const layout = useSidebarLayout();
  const expanded = useExpandedParents();

  const knownProjectKeys = [
    ...data.projects.map((project) => projectFilterKey(project.id)),
    ...data.remoteProjects.map((project) => projectFilterKey(project.id, project.hostId)),
  ];
  const projectsShown = appliedProjectFilter(projectFilter.selected, knownProjectKeys);
  const list = deriveSessionList({
    sessions: filterSessionsToProjects(data.sessions, projectsShown),
    query,
    ...(activeSessionId ? { activeSessionId } : {}),
    now: data.renderedAt,
    autoSettleAfterHours,
    windowsByHost: data.hostWindows,
    limit: sessionLimit,
    settledLimit,
    order: layout.mode === "flat" ? "activity" : "created",
  });
  const bandFor = (session: SidebarSession) =>
    bandOf(session, { now: data.renderedAt, autoSettleAfterHours: windowFor(session, autoSettleAfterHours, data.hostWindows) });
  const grouped =
    list.flat || layout.mode === "flat" ? undefined : groupSessions(list, layout.order, { sessions: layout.sessionOrder, pinned: layout.pinnedOrder });
  const flatEntries = !list.flat && layout.mode === "flat" ? flattenSessions(list, layout.pinnedOrder) : undefined;
  const drawnGroups = grouped ? grouped.groups : [];
  const drawnGroupKeys = drawnGroups.map((group) => group.key);

  const drag = useRailDrag(layout, Boolean(grouped), drawnGroupKeys);
  const pinnedRowDrag = drag.rowDrag(PINNED_ROW_SCOPE, grouped ? grouped.pinned.map((session) => sessionKey(session)) : []);
  const moveGroup = (key: string, direction: "up" | "down") => {
    const next = moveProjectGroupStep(layout.order, drawnGroupKeys, key, direction);
    return next && (() => void layout.setOrder(next));
  };

  const jumpRows = grouped
    ? railRowsForCommandKeys({ ...grouped, groups: drawnGroups }, collapsed.collapsed)
    : flatEntries
      ? flatRailRows(flatEntries, expanded.expanded, activeSessionId).slice(0, RAIL_JUMP_SLOTS.length)
      : list.sessions.slice(0, RAIL_JUMP_SLOTS.length);
  const jumpSlots = railJumpSlots(jumpRows);
  const env: RowEnv = {
    ...(activeSessionId ? { activeSessionId } : {}),
    renderedAt: data.renderedAt,
    bandFor,
    onRowChanged: data.onRowChanged,
    jumpSlotFor: (key) => jumpSlots.get(key),
  };

  return {
    projectFilter,
    projectsShown,
    layout,
    list,
    grouped,
    flatEntries,
    drawnGroups,
    drawnGroupKeys,
    drag,
    pinnedRowDrag,
    moveGroup,
    collapsed,
    expanded,
    jumpRows,
    env,
    showingStale: data.unavailable && data.sessions.length > 0,
  };
}

export type RailView = ReturnType<typeof useRailView>;
