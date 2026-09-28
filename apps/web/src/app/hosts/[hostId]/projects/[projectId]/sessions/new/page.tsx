import { SessionCockpit } from "@/components/session-cockpit";

/**
 * A NEW CONVERSATION ON ANOTHER MAC. Same front door as the local canvas
 * (app/projects/[projectId]/sessions/new/page.tsx) — nothing is created by
 * arriving — and, since #407, the same shape: no engine read stands in the path
 * of the navigation.
 *
 * IT MATTERED MORE HERE THAN LOCALLY. This page used to resolve the project's
 * name by forwarding a request THROUGH THE OTHER MAC'S PROXY, so pressing "New
 * conversation" on a remote project could not commit until a request had crossed
 * the network and come back — and if that Mac was asleep, until it had timed
 * out. The cockpit reads the same list on mount, routed by the address bar to
 * the same engine; the breadcrumb falls back to the id, which is addressing
 * rather than a name, and is the honest thing to show until it answers.
 */
export const dynamic = "force-dynamic";

export default async function RemoteNewSessionPage({ params }: { params: Promise<{ hostId: string; projectId: string }> }) {
  const { projectId } = await params;
  return <SessionCockpit projectId={projectId} />;
}
