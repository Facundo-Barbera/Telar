import { SessionCockpit } from "@/components/session-cockpit";

/**
 * A SOLO CONVERSATION ON ANOTHER MAC — the same chromeless screen at an address
 * that names the Mac, exactly as the ordinary session page has its own remote
 * twin. Every api call is routed by the address bar (lib/hosts/client.ts), so
 * the component still needs to know nothing; the route prefix is the whole
 * difference (#576).
 */
export const dynamic = "force-dynamic";

export default async function RemoteSoloSessionPage({
  params,
}: {
  params: Promise<{ hostId: string; projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionCockpit projectId={projectId} sessionId={sessionId} solo />;
}
