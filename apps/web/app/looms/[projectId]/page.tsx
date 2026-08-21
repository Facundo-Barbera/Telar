import { LoomOrchestrator } from "@/components/loom/orchestrator";
import { loomView } from "@/lib/loom-views";

/**
 * ONE PROJECT: its deck, its Program, its ledger, its conversation — one of
 * them at a time, in one content column beside the app sidebar.
 *
 * `?view=` IS READ HERE rather than with `useSearchParams`, so the segment is
 * linkable without a suspense boundary anyone can forget. An unrecognised value
 * is the Deck; a shared link that outlives a segment name should land somewhere
 * useful rather than on an error.
 */
export const dynamic = "force-dynamic";

export default async function LoomOrchestratorPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { projectId } = await params;
  const { view } = await searchParams;
  return <LoomOrchestrator projectId={projectId} view={loomView(view)} />;
}
