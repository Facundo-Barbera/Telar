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
 */
export default async function NewSessionPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SessionCockpit projectId={projectId} />;
}
