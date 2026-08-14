import { redirect } from "next/navigation";
import { vnextEngine } from "@/lib/vnext/engine-server";
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
    const engine = await vnextEngine();
    const { projects } = await engine.listProjects();
    if (projects.length === 0) return { unreachable: false };
    if (projects.length === 1) return { href: canvas(projects[0]!.id), unreachable: false };

    // Several projects: the one you were last working in. Sessions are local
    // file reads, so asking each project is cheap — and asking is the only way
    // to know, because a project record's own `updatedAt` moves when it is
    // registered rather than when it is used.
    const recency = await Promise.all(
      projects.map(async (project) => {
        try {
          const { sessions } = await engine.listSessions(project.id);
          return { id: project.id, at: Math.max(0, ...sessions.map((session) => session.updatedAt)) };
        } catch {
          return { id: project.id, at: 0 };
        }
      }),
    );
    const newest = recency.sort((left, right) => right.at - left.at)[0]!;
    // Every project cold: fall back to the most recently registered rather than
    // to whichever one sorted first by accident.
    const cold = [...projects].sort((left, right) => right.createdAt - left.createdAt)[0]!;
    return { href: canvas(newest.at === 0 ? cold.id : newest.id), unreachable: false };
  } catch {
    // The engine is not answering. A redirect would land the reader on a canvas
    // that cannot explain itself; the first-run screen can.
    return { unreachable: true };
  }
}

function canvas(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}
