import { redirect } from "next/navigation";
import { engineClient } from "@/lib/engine/engine-server";
import { FirstRun } from "@/components/first-run";

/**
 * THE FRONT DOOR IS A COMPOSER, AND NOW IT IS ONLY THAT.
 *
 * It used to be this app's projects table — a panel of registered roots beside a
 * list of sessions labelled with their raw ids. Everything in it was true and
 * none of it was what anybody opened Telar to do. Starting a conversation meant
 * finding a project, finding a button inside it, and only then arriving
 * somewhere you could type; the screen a person wanted was three clicks past the
 * screen they got.
 *
 * The table moved to `/projects` and has now been RETIRED, along with that
 * route. It was the destination of four different actions — a delete, a
 * breadcrumb, a menu item, a dropdown glyph — none of which meant to send
 * anybody to a management screen, and being a real URL it survived reloads. So
 * the app kept resuming on a page nobody had chosen. Every one of those actions
 * now goes somewhere it meant.
 *
 * WHICH PROJECT: the one owning the most recently touched session, else the
 * most recently registered. That is a guess, and it is the same guess the
 * sidebar's new-conversation button already makes, so the two cannot disagree.
 *
 * THE ONE SCREEN THAT IS NOT A COMPOSER is the case where a composer is
 * impossible: no project to open one against, or an engine that cannot say. See
 * `components/first-run.tsx`.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const resolved = await resolveComposer();
  if (resolved.href) redirect(resolved.href);
  return <FirstRun unreachable={resolved.unreachable} />;
}

/**
 * ONE ANSWER, THREE OUTCOMES — a destination, no projects, or no engine.
 *
 * Returned together rather than asked twice: "did that fail, or was it just
 * empty" is knowledge this function already has, and re-deriving it with a
 * second call would be a second chance to disagree with the first.
 */
async function resolveComposer(): Promise<{ href?: string; unreachable: boolean }> {
  try {
    const engine = await engineClient();
    const { projects } = await engine.listProjects();
    if (projects.length === 0) return { unreachable: false };
    if (projects.length === 1) return { href: canvas(projects[0]!.id), unreachable: false };

    /**
     * Several projects: the one you were last working in — from ONE read.
     *
     * This used to ask `listSessions` per project, on the reasoning that a
     * session list is a local file read and therefore cheap. It is not cheap
     * per PROJECT: each call reads every session in the store and filters, so
     * the cost is projects × sessions. Measured on a real store (14 projects,
     * 114 sessions) this route spent **1.7-2.9 s** deciding a redirect — and it
     * is the first thing the desktop window loads, so that time is the launch.
     * `liveSessions` answers the same question in one pass.
     *
     * IT COUNTS ACTIVE SESSIONS ONLY, which the per-project version did not. A
     * project whose sessions are all archived now reads as cold and falls to
     * the registry order below — the better answer anyway: "where you were last
     * working" should not resurrect a project you finished with.
     */
    const { sessions } = await engine.liveSessions();
    return { href: canvas(composerProject(projects, sessions)), unreachable: false };
  } catch {
    // The engine is not answering. A redirect would land the reader on a canvas
    // that cannot explain itself; the first-run screen can.
    return { unreachable: true };
  }
}

/**
 * Which project the front door opens: the one owning the most recently touched
 * ACTIVE session, else the most recently registered.
 *
 * Exported and pure so the decision is testable without a server — the route
 * around it is now only a read and a redirect (`lib/composer-project.test.ts`).
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
   * EVERY PROJECT COLD — including the case this route did not have before:
   * a project whose only sessions are ARCHIVED. `liveSessions` reports active
   * ones, so an archived-only project scores 0 and lands here rather than
   * winning on the strength of a conversation somebody finished with. The
   * fallback is the most recently REGISTERED project, which is a deliberate
   * answer rather than whichever id happened to sort first.
   */
  return [...projects].sort((left, right) => right.createdAt - left.createdAt)[0]!.id;
}

function canvas(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}
