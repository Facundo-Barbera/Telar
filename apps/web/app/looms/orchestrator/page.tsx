import { redirect } from "next/navigation";

/**
 * THE OLD MOCKUP'S ADDRESS.
 *
 * `/looms/orchestrator` was a hardcoded, engine-less sketch of a page that had
 * no project. The real orchestrator is per project and lives at
 * `/looms/[projectId]`, so this address redirects to the deck, which is where
 * you choose one. It is a redirect rather than a deletion because the URL was
 * shared while the mockup was up, and a 404 would look like a routing bug.
 */
export default function LegacyOrchestratorPage() {
  redirect("/looms");
}
