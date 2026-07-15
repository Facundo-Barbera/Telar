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
  const chats = listChats(project, { archived }).filter(
    (c) => c.role !== "steerer" && c.role !== "escalation",
  );
  return Response.json({ chats });
}
