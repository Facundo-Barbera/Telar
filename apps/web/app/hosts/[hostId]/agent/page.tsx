import { AgentScreen } from "@/components/agent/agent-screen";

/**
 * ANOTHER MAC'S AGENT — the same screen, at an address that names the Mac.
 *
 * THE ROUTE PREFIX IS THE WHOLE DIFFERENCE, exactly as it is for a session on
 * another Mac (`hosts/[hostId]/projects/…/sessions/[sessionId]`): every API call
 * underneath is routed by the address bar (lib/hosts/client.ts), so the
 * component is told nothing and there is one `AgentScreen` rather than a local
 * one and a remote one that would drift.
 *
 * WHY IT HAS TO EXIST AT ALL. Each Mac has its own Agent, and the rail's entry
 * follows the Mac you are LOOKING at. Without this route that entry would
 * address a bare `/agent` — which resolves against the LOCAL engine and opens
 * this cockpit's own Agent: the right shape of screen, the wrong machine, and
 * nothing on it saying which.
 */
export const dynamic = "force-dynamic";

export default function RemoteAgentPage() {
  return <AgentScreen />;
}
