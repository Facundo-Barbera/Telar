import { SessionCockpit } from "@/components/vnext/session-cockpit";

export const dynamic = "force-dynamic";

export default async function VNextSessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionCockpit projectId={projectId} sessionId={sessionId} />;
}
