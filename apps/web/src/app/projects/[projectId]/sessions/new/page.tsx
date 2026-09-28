import { SessionCockpit } from "@/features/sessions/cockpit";

/**
 * The new-conversation front door.
 *
 * NOTHING IS CREATED BY ARRIVING HERE. The same cockpit renders with no session
 * id, which lifts the composer to the middle of the screen and leaves the
 * transcript empty; the first message is what mints the session and rewrites
 * this URL to its id. Opening a blank canvas and walking away therefore leaves
 * no empty session behind in the rail.
 *
 * THE PROJECT'S NAME IS NO LONGER RESOLVED HERE (#407), and that is a fix
 * rather than a regression. It was read on the server so the greeting would not
 * paint the raw id and correct itself a moment later — a real problem with the
 * wrong remedy. One engine read on the server is one engine read IN THE PATH OF
 * THE NAVIGATION: pressing "New conversation" could not commit until Next had
 * asked the engine for every project, and on the owner's store that is the
 * stall the issue reports. The cockpit reads the same list on mount anyway.
 *
 * THE PHRASE IS NO LONGER PICKED AT ALL. It used to be one of fourteen, chosen
 * at random per request — see `features/composer/greetings.ts` for why the rotation went.
 */
export const dynamic = "force-dynamic";

export default async function NewSessionPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <SessionCockpit projectId={projectId} />;
}
