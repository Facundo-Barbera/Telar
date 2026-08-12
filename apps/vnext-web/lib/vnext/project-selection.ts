import type { EngineSession } from "@telar/engine-client";

/** A session list is valid only for the project response that produced it. */
export function sessionsForSelectedProject(
  sessions: EngineSession[],
  selectedProjectId: string | undefined,
  sessionsProjectId: string | undefined,
): EngineSession[] {
  return selectedProjectId && selectedProjectId === sessionsProjectId ? sessions : [];
}
