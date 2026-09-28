import type { SidebarSession } from "@/features/sessions";

export type ProjectPlace = {
  hostId?: string;
  hostName?: string;
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
