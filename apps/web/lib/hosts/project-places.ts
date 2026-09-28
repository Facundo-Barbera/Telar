import type { SidebarSession } from "@/lib/session-list";

/**
 * Every Mac with a live row in a project group, with that Mac's own project id (ids are per
 * engine). Read off the rows, this Mac first, remotes by name so the order is stable.
 */
export type ProjectPlace = {
  /** Absent for this Mac, as in `SidebarSession.hostId`. */
  hostId?: string;
  hostName?: string;
  /** That Mac's own id for this project. */
  projectId: string;
};

export function projectPlaces(
  sessions: readonly Pick<SidebarSession, "hostId" | "hostName" | "projectId">[],
): ProjectPlace[] {
  const places = new Map<string, ProjectPlace>();
  for (const session of sessions) {
    if (!session.projectId) continue;
    const key = `${session.hostId ?? ""}:${session.projectId}`;
    if (places.has(key)) continue;
    places.set(key, {
      ...(session.hostId ? { hostId: session.hostId } : {}),
      ...(session.hostName ? { hostName: session.hostName } : {}),
      projectId: session.projectId,
    });
  }
  return [...places.values()].sort(
    (left, right) =>
      Number(Boolean(left.hostId)) - Number(Boolean(right.hostId)) ||
      (left.hostName ?? "").localeCompare(right.hostName ?? "") ||
      left.projectId.localeCompare(right.projectId),
  );
}
