import type { SidebarSession } from "@/lib/session-list";

/**
 * WHERE ONE PROJECT GROUP ACTUALLY LIVES — every Mac that has a checkout of
 * this repository, and that Mac's OWN id for it.
 *
 * Once two Macs' checkouts of one repository draw as one group
 * (`projectGroupKey`), the group's header can no longer be described by a
 * single `(hostId, projectId)` pair: the ids are minted per engine, so B's copy
 * is `project_9f…` over there and `project_2a…` here, and a "New conversation"
 * built from one of them opens nothing on the other. The header needs the list,
 * which is what this is.
 *
 * READ OFF THE ROWS, not fetched. Every row already carries the Mac it came
 * from and that Mac's project id — they are what the group was assembled out of
 * — so the places are a projection of the group, and a group cannot disagree
 * with its own header about where it lives.
 *
 * THIS MAC FIRST, always. A merged group's default destination should be the
 * checkout that opens without a hop, whose folder Finder can actually reveal,
 * and whose settings page exists; the remotes follow in their own name order so
 * the list does not re-shuffle itself between polls.
 *
 * A MAC WITH NOTHING LIVE IS NOT A PLACE HERE, and that is honest rather than
 * incomplete: the rail is a list of conversations, this group exists because
 * some Mac has one, and a Mac that has none contributes no row to read. Its
 * checkout is still reachable from the New menu at the top of the rail, which
 * reads the project registries rather than the rows.
 */
export type ProjectPlace = {
  /** Absent for this Mac — the same convention as `SidebarSession.hostId`. */
  hostId?: string;
  hostName?: string;
  /** That Mac's own id for this project. Ids are minted per engine. */
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
