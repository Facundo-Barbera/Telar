import { getLoom } from "@telar/core";
import { getChat, listChats } from "@/lib/store";
import type { InitialChat } from "@/components/session/session-view";

export const dynamic = "force-dynamic";

// Read-only continuity seed for the loom Chat tab (docs/loom-model.md §5). No
// moat surface: it never writes, never accepts — it just returns the most-
// recent non-archived STEERER chat anchored to this loom (shaped as an
// InitialChat) so a reload/tab-switch re-attaches to the same steering session
// instead of starting fresh. `{ chat: null }` when there is none (or the loom
// is unknown) → the tab opens a brand-new steerer session.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loom = getLoom(id);
  if (!loom) return Response.json({ chat: null });

  // listChats is anchored by project and excludes archived by default; narrow to
  // this loom's steerer sessions, newest by updatedAt.
  const latest = listChats(loom.project)
    .filter((c) => c.role === "steerer" && c.loomId === id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!latest) return Response.json({ chat: null });

  // getChat carries the full transcript + accumulated totals (the summary above
  // omits messages) — shape it exactly as the session page seeds SessionView.
  const chat = getChat(latest.id);
  if (!chat) return Response.json({ chat: null });

  const initial: InitialChat = {
    id: chat.id,
    model: chat.model,
    effort: chat.effort,
    permissionMode: chat.permissionMode,
    messages: chat.messages,
    costUsd: chat.costUsd,
    inputTokens: chat.inputTokens ?? 0,
    outputTokens: chat.outputTokens ?? 0,
    cacheReadTokens: chat.cacheReadTokens ?? 0,
    cacheCreateTokens: chat.cacheCreateTokens ?? 0,
    contextTokens: chat.contextTokens ?? 0,
    loomId: chat.loomId,
    role: chat.role,
  };
  return Response.json({ chat: initial });
}
