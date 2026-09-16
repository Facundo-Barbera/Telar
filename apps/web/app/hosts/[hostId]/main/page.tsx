import { MainAssistant } from "@/components/main-assistant";

/**
 * ANOTHER MAC'S MAIN CONVERSATION — the same screen, at an address that names
 * the Mac.
 *
 * THE ROUTE PREFIX IS THE WHOLE DIFFERENCE, exactly as it is for a session on
 * another Mac (`hosts/[hostId]/projects/…/sessions/[sessionId]`): every API call
 * underneath is routed by the address bar (lib/hosts/client.ts), so the
 * component is told nothing and there is one `MainAssistant` rather than a
 * local one and a remote one that would drift.
 *
 * WHY IT HAS TO EXIST AT ALL. Each Mac designates its own coordinator, and a
 * paired Mac's rows are in this cockpit's rail. Without this route their Main
 * row addressed a bare `/main` — which resolved against the LOCAL engine and
 * opened this cockpit's own coordinator: the right shape of screen, the wrong
 * machine, and nothing on it saying which.
 */
export const dynamic = "force-dynamic";

export default function RemoteMainAssistantPage() {
  return <MainAssistant />;
}
