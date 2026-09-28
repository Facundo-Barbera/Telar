import { SessionCockpit } from "@/features/sessions";

export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId, sessionId } = await params;
  return <SessionCockpit projectId={projectId} sessionId={sessionId} />;
}
