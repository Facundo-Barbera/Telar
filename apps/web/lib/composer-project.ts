/**
 * WHICH PROJECT THE FRONT DOOR OPENS, and the note it leaves itself.
 *
 * The decision used to be made on the server, inside `app/page.tsx`, which made
 * the first thing the desktop window loads a round trip to Next and two reads of
 * the engine before a single byte of the app could paint. The decision is the
 * same; it is now made in the browser, and the note below is what lets the
 * common case skip the reads entirely — see `app/front-door.tsx`.
 */
import type { Project } from "@telar/engine-client";

/**
 * Which project the front door opens: the one owning the most recently touched
 * ACTIVE session, else the most recently registered.
 *
 * Pure so the decision is testable without a server or a browser
 * (`lib/composer-project.test.ts`).
 */
export function composerProject(
  projects: readonly { id: string; createdAt: number }[],
  sessions: readonly { projectId?: string; updatedAt: number }[],
): string {
  const recency = new Map(projects.map((project) => [project.id, 0]));
  for (const session of sessions) {
    if (!session.projectId) continue;
    const at = recency.get(session.projectId);
    // A session whose project is not in this registry (removed, or another
    // engine's) cannot vote for a destination that does not exist.
    if (at === undefined) continue;
    if (session.updatedAt > at) recency.set(session.projectId, session.updatedAt);
  }
  const newest = [...recency].map(([id, at]) => ({ id, at })).sort((left, right) => right.at - left.at)[0]!;
  if (newest.at > 0) return newest.id;
  /**
   * EVERY PROJECT COLD — including the case this decision did not have before:
   * a project whose only sessions are ARCHIVED. `liveSessions` reports active
   * ones, so an archived-only project scores 0 and lands here rather than
   * winning on the strength of a conversation somebody finished with. The
   * fallback is the most recently REGISTERED project, which is a deliberate
   * answer rather than whichever id happened to sort first.
   */
  return [...projects].sort((left, right) => right.createdAt - left.createdAt)[0]!.id;
}

export function canvasHrefFor(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}

/**
 * WHAT THE LAST VISIT LEFT FOR THE NEXT ONE (#407).
 *
 * The front door's answer is "where you were last working", and the app already
 * knows that the whole time it is open — every cockpit mount names a project.
 * Written there and read here, the launch can redirect on its FIRST frame
 * instead of after two engine reads, and the reads that follow only correct a
 * note that is almost always already right.
 *
 * A WRONG NOTE COSTS ONE LAUNCH, NOT A WEDGE. The cockpit rewrites it from the
 * live list on arrival, so a project removed since the last visit is corrected
 * by the very screen the stale note opened.
 */
const CACHE_KEY = "telar.front-door.v1";

export type FrontDoorNote = {
  /** The registry as last seen — enough to decide without the engine, and to
   *  name a project in a breadcrumb before the first fetch lands. */
  projects: { id: string; createdAt: number; name?: string }[];
  /** The project the last visit was actually in, which outranks the fold: it
   *  is an observation rather than a guess. */
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
    // A note that cannot be read is a note that was not there. Nothing here is
    // authoritative, so there is nothing to report.
    return undefined;
  }
}

/** Where the note says to go, or nothing when it cannot say. */
export function noteDestination(note: FrontDoorNote | undefined): string | undefined {
  if (!note) return undefined;
  const known = new Set(note.projects.map((project) => project.id));
  if (note.composer && known.has(note.composer)) return canvasHrefFor(note.composer);
  if (note.projects.length === 0) return undefined;
  return canvasHrefFor(composerProject(note.projects, []));
}

/**
 * WHAT THIS PROJECT IS CALLED, as of the last time anything looked.
 *
 * The canvas used to resolve the name on the SERVER so the greeting would not
 * paint a raw id and correct itself a moment later — one engine read standing
 * in the path of every "New conversation" press. The note already holds the
 * registry, so the same flash is avoided by remembering rather than by blocking.
 * `undefined` on a genuinely first visit, which is the one case that still shows
 * an id for the length of a fetch.
 */
export function rememberedProjectName(projectId: string): string | undefined {
  return readFrontDoorNote()?.projects.find((project) => project.id === projectId)?.name;
}

export function writeFrontDoorNote(projects: readonly Project[], composer?: string): void {
  try {
    const known = projects.map((project) => ({ id: project.id, createdAt: project.createdAt, ...(project.name ? { name: project.name } : {}) }));
    const note: FrontDoorNote = {
      projects: known,
      // Only a project that still exists. A note naming a removed one would
      // send the next launch to a canvas with nothing behind it.
      ...(composer && known.some((project) => project.id === composer) ? { composer } : {}),
      at: Date.now(),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(note));
  } catch {
    // Private mode, a full quota, a browser with storage off — the front door
    // simply pays for its reads again. Never a reason to fail a render.
  }
}
