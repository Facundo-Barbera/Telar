import { notFound } from "next/navigation";
import { SessionCockpit } from "@/components/session-cockpit";
import { getLoom } from "@/lib/looms/store";

/**
 * A THREAD'S TRANSCRIPT, INSIDE THE LOOM'S HOME.
 *
 * Loom sessions are not ordinary Telar sessions — they are detached, owned by
 * the loom, and subtracted from every ordinary surface. Opening one therefore
 * must not eject the reader into `/projects/...`: this route mounts the same
 * cockpit UNDER `/looms`, so the rail stays the looms floor plan and the
 * reader never leaves the place. The cockpit itself is reused wholesale — the
 * transcript is the same machinery either way; only the address is loom-owned.
 */
export const dynamic = "force-dynamic";

export default async function LoomThreadPage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const loom = getLoom(id);
  if (!loom) notFound();
  const owned = loom.originSessionId === sessionId || loom.threads.some((t) => t.sessionId === sessionId);
  if (!owned) notFound();
  return <SessionCockpit projectId={loom.projectId} sessionId={sessionId} />;
}
