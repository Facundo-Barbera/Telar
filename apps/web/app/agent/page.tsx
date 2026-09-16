import { AgentScreen } from "@/components/agent/agent-screen";

/**
 * `/agent` — this Mac's built-in Agent (#531).
 *
 * A RESERVED ADDRESS RATHER THAN `/sessions/<id>`, and that is the whole reason
 * it is its own route: the Agent is not a session. It has no id in that
 * namespace, it belongs to no project, and the thread behind it is replaced
 * outright by a reset — so there is no session URL to build and nothing that
 * would still be true a month later. A person who bookmarks this one wants "the
 * Agent", and this address outlives every thread it draws.
 *
 * THE SERVER RENDERS NOTHING ABOUT IT, because it would have to ask the engine
 * to know anything, and asking here would make every load of this page wait on
 * that before the first paint. The client reads the same route the settings
 * pane does and then follows the stream.
 */
export const dynamic = "force-dynamic";

export default function AgentPage() {
  return <AgentScreen />;
}
