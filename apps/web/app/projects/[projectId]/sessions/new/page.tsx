import { GREETINGS } from "@/lib/greetings";
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
 * THE GREETING IS RESOLVED HERE, ON THE SERVER, and that is a fix rather than a
 * refactor. It used to assemble itself in three visible steps: the plain phrase
 * with the project's raw ID, then a random phrase, then the name once a client
 * fetch returned. Every one of those steps was the page telling the reader
 * about its own plumbing.
 *
 * Both facts are known here — the name is one local read, and the phrase is a
 * number this process can pick — so the first paint is the final paint. Picking
 * the phrase on the SERVER is also what makes rotation free of hydration
 * trouble: it arrives as a prop, so the client never disagrees about it.
 */
export default async function NewSessionPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SessionCockpit projectId={projectId} {...(await canvas(projectId))} />;
}

/**
 * Everything the greeting needs, resolved once per request.
 *
 * THE PICK LIVES HERE RATHER THAN IN THE COMPONENT BODY. Choosing a phrase is
 * impure by definition, and an impure call during render is a real hazard in
 * React's model even when this particular component renders once on a server —
 * so it happens in a plain async function, which is also where the name lookup
 * already was.
 *
 * `projectName` is absent when the engine cannot be reached. The breadcrumb
 * then falls back to the id, which is addressing rather than a name, and is the
 * honest thing to show when nothing better is known.
 */
async function canvas(projectId: string): Promise<{ projectName?: string; greeting: number }> {
  const greeting = Math.floor(Math.random() * GREETINGS.length);
  try {
    const { projects } = await (await engineClient()).listProjects();
    const found = projects.find((project) => project.id === projectId);
    return { ...(found ? { projectName: found.name } : {}), greeting };
  } catch {
    return { greeting };
  }
}
