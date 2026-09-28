import { SessionCockpit } from "@/features/sessions";

/**
 * A SESSION ON ANOTHER MAC — the same cockpit, at an address that names the
 * Mac. Every api call the cockpit makes is routed by the address bar
 * (platform/engine/host-client.ts), so the component needs to know nothing; the route
 * prefix is the whole difference.
 */
export const dynamic = "force-dynamic";

export default async function RemoteSessionPage({
  params,
}: {
  params: Promise<{ hostId: string; projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionCockpit projectId={projectId} sessionId={sessionId} />;
}
