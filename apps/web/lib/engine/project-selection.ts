import type { Session } from "@telar/engine-client";

/** A session list is valid only for the project response that produced it. */
export function sessionsForSelectedProject(
  sessions: Session[],
  selectedProjectId: string | undefined,
  sessionsProjectId: string | undefined,
): Session[] {
  return selectedProjectId && selectedProjectId === sessionsProjectId ? sessions : [];
}
