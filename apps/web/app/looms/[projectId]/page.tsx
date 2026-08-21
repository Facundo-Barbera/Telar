import { LoomOrchestrator } from "@/components/loom/orchestrator";

/**
 * ONE PROJECT'S ORCHESTRATOR: its looms, its conversation, its Program.
 *
 * The centre pane is the STOCK session cockpit, which resolves its own session
 * on the client, so this page has nothing to await beyond the route param.
 */
export const dynamic = "force-dynamic";

export default async function LoomOrchestratorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <LoomOrchestrator projectId={projectId} />;
}
