import type { Project } from "@telar/engine-client";

/** The project owning the most recently touched active session, else the most recently registered. */
export function composerProject(
  projects: readonly { id: string; createdAt: number }[],
  sessions: readonly { projectId?: string; updatedAt: number }[],
): string {
  const recency = new Map(projects.map((project) => [project.id, 0]));
  for (const session of sessions) {
    if (!session.projectId) continue;
    const at = recency.get(session.projectId);
    // A removed project, or another engine's, cannot be a destination.
    if (at === undefined) continue;
    if (session.updatedAt > at) recency.set(session.projectId, session.updatedAt);
  }
  const newest = [...recency].map(([id, at]) => ({ id, at })).sort((left, right) => right.at - left.at)[0]!;
  if (newest.at > 0) return newest.id;
  return [...projects].sort((left, right) => right.createdAt - left.createdAt)[0]!.id;
}

export function canvasHrefFor(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}

/**
 * Note left by the last visit so launch can redirect on its first frame. A stale
 * note costs one launch: the cockpit rewrites it from the live list on arrival.
 */
const CACHE_KEY = "telar.front-door.v1";

type FrontDoorNote = {
  projects: { id: string; createdAt: number; name?: string }[];
  /** The project last visited; outranks the fold. */
  composer?: string;
  at: number;
};

export function readFrontDoorNote(): FrontDoorNote | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<FrontDoorNote> | null;
    if (!parsed || !Array.isArray(parsed.projects)) return undefined;
    const projects = parsed.projects.filter(
      (project): project is { id: string; createdAt: number; name?: string } =>
        typeof project?.id === "string" && typeof project?.createdAt === "number",
    );
    if (projects.length === 0) return undefined;
    return {
      projects,
      ...(typeof parsed.composer === "string" ? { composer: parsed.composer } : {}),
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return undefined;
  }
}

export function noteDestination(note: FrontDoorNote | undefined): string | undefined {
  if (!note) return undefined;
  const known = new Set(note.projects.map((project) => project.id));
  if (note.composer && known.has(note.composer)) return canvasHrefFor(note.composer);
  if (note.projects.length === 0) return undefined;
  return canvasHrefFor(composerProject(note.projects, []));
}

/** The project's name as last seen, so the greeting needn't flash a raw id; `undefined` on a first visit. */
export function rememberedProjectName(projectId: string): string | undefined {
  return readFrontDoorNote()?.projects.find((project) => project.id === projectId)?.name;
}

export function writeFrontDoorNote(projects: readonly Project[], composer?: string): void {
  try {
    const known = projects.map((project) => ({ id: project.id, createdAt: project.createdAt, ...(project.name ? { name: project.name } : {}) }));
    const note: FrontDoorNote = {
      projects: known,
      ...(composer && known.some((project) => project.id === composer) ? { composer } : {}),
      at: Date.now(),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(note));
  } catch {
    // Private mode or full quota: the front door just pays for its reads again.
  }
}
