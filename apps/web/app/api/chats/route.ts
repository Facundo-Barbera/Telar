import { listUltraRuns } from "@telar/core";
import { isSessionRunLive } from "@/lib/chat-runs";
import { liveRunCountsBySession } from "@/lib/ultra-runs";
import { listChats } from "@/lib/store";

export const dynamic = "force-dynamic";

// The general chat-list surface — every "regular session list" consumer
// (app-sidebar.tsx's recents, the dashboard, /projects, a project's Sessions
// tab) fetches through here. Loom-born sessions (role "steerer"/"escalation":
// the loom Chat tab and M11.3's blocked-loom "Discuss with the orchestrator"
// chat) are filtered OUT unconditionally — they're scoped to their loom and
// reachable only from its own UI, never this list, so a chat bound to a loom
// never shows up twice (once here, once in the loom's own Chat tab/escalation
// surface) and the escalation kickoff's machinery never surfaces as a stray
// session either. Anything that legitimately needs a loom-born chat back
// (chat-tab.tsx, discuss-escalation.tsx) reads it via GET
// /api/looms/[id]/chat instead of this endpoint, so it's unaffected.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? undefined;
  const raw = url.searchParams.get("archived");
  const archived = raw === "include" || raw === "only" ? raw : "exclude";
  // `live`'s registry (lib/chat-runs.ts) only knows about the MAIN turn's own
  // HTTP request. An Ultra run keeps going as its own detached process long
  // after that request returns (its manifest lives under TELAR_HOME/ultra/*),
  // so a session can be doing real work while `live` alone says idle — issue
  // #17. One directory walk here answers it for every chat in this response
  // at once, the same cost /api/ultra's own list route already pays on its
  // poll cadence; a manifest that fails to read degrades to "nothing running"
  // rather than a 500 for the whole chat list, the same guard that route
  // wraps around this exact call.
  let liveUltraCounts: Map<string, number>;
  try {
    liveUltraCounts = liveRunCountsBySession(listUltraRuns());
  } catch {
    liveUltraCounts = new Map();
  }
  const chats = listChats(project, { archived })
    .filter((c) => c.role !== "steerer" && c.role !== "escalation")
    // `live` is the sidebar's running dot. It is DERIVED per request from the
    // in-flight registry (lib/chat-runs.ts) and never persisted — a turn that
    // dies with the server must not leave a row claiming to be running. This is
    // the same registry POST /api/chat/stop reaches, so the dot and the stop
    // button can never disagree about whether a turn exists.
    .map((c) => {
      const liveBackgroundRuns = liveUltraCounts.get(c.id);
      return {
        ...c,
        live: isSessionRunLive(c.id),
        // Only present when positive — absent reads the same as "nothing
        // running", same optional-field convention `live`'s own callers use.
        ...(liveBackgroundRuns ? { liveBackgroundRuns } : {}),
      };
    });
  return Response.json({ chats });
}
