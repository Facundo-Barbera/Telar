import { redirect } from "next/navigation";
import { vnextEngine } from "@/lib/vnext/engine-server";
import { ProjectsCockpit } from "@/components/projects-cockpit";

/**
 * THE FRONT DOOR IS A COMPOSER.
 *
 * It used to be this app's projects table — a panel of registered roots beside a
 * list of sessions labelled with their raw ids. Everything in it was true and
 * none of it was what anybody opened Telar to do. Starting a conversation meant
 * finding a project, finding a button inside it, and only then arriving
 * somewhere you could type; the screen a person wanted was three clicks past the
 * screen they got.
 *
 * So `/` resolves a project and sends you to its new-conversation canvas. The
 * table still exists and still says everything it said — it moved to
 * `/projects`, which is where a screen for MANAGING projects belongs.
 *
 * WHICH PROJECT: the one owning the most recently touched session, else the
 * most recently registered. That is a guess, and it is the same guess the
 * sidebar's new-conversation button already makes, so the two cannot disagree.
 *
 * NO PROJECTS IS THE ONE CASE WHERE A TABLE IS THE HONEST ANSWER — there is
 * nothing to open a conversation against, and the thing to do is register a
 * root. Same when the engine cannot be reached: a redirect into a session
 * canvas that will only fail to load is worse than the screen that can explain
 * why.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const destination = await resolveComposer();
  if (destination) redirect(destination);
  return <ProjectsCockpit />;
}

async function resolveComposer(): Promise<string | undefined> {
  try {
    const engine = await vnextEngine();
    const { projects } = await engine.listProjects();
    if (projects.length === 0) return undefined;
    if (projects.length === 1) return canvas(projects[0]!.id);

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
    if (newest.at === 0) return canvas([...projects].sort((left, right) => right.createdAt - left.createdAt)[0]!.id);
    return canvas(newest.id);
  } catch {
    // The engine is not answering. The table says so properly; a redirect would
    // land the reader on a canvas that cannot explain itself.
    return undefined;
  }
}

function canvas(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}
