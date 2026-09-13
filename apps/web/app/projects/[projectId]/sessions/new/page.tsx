import { engineClient } from "@/lib/engine/engine-server";
import { SessionCockpit } from "@/components/session-cockpit";

export const dynamic = "force-dynamic";

/**
 * The new-conversation front door.
 *
 * NOTHING IS CREATED BY ARRIVING HERE. The same cockpit renders with no session
 * id, which lifts the composer to the middle of the screen and leaves the
 * transcript empty; the first message is what mints the session and rewrites
 * this URL to its id. Opening a blank canvas and walking away therefore leaves
 * no empty session behind in the rail.
 *
 * THE PROJECT'S NAME IS RESOLVED HERE, ON THE SERVER, and that is a fix rather
 * than a refactor. The greeting used to assemble itself in visible steps: the
 * phrase with the project's raw ID, then the name once a client fetch returned.
 * Every one of those steps was the page telling the reader about its own
 * plumbing. One local read here means the first paint is the final paint.
 *
 * THE PHRASE IS NO LONGER PICKED AT ALL. It used to be one of fourteen, chosen
 * at random per request — see `lib/greetings.ts` for why the rotation went.
 */
export default async function NewSessionPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SessionCockpit projectId={projectId} {...(await canvas(projectId))} />;
}

/**
 * `projectName` is absent when the engine cannot be reached. The breadcrumb
 * then falls back to the id, which is addressing rather than a name, and is the
 * honest thing to show when nothing better is known.
 */
async function canvas(projectId: string): Promise<{ projectName?: string }> {
  try {
    const { projects } = await (await engineClient()).listProjects();
    const found = projects.find((project) => project.id === projectId);
    return found ? { projectName: found.name } : {};
  } catch {
    return {};
  }
}
