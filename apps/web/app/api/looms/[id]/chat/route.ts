import { getLoom } from "@telar/core";
import { getChat, listChats } from "@/lib/store";
import type { InitialChat } from "@/components/session/session-view";

export const dynamic = "force-dynamic";

// Read-only continuity seed for a loom-born session — the loom Chat tab
// (STEERER) and M11.3's blocked-loom "Discuss with the orchestrator" surface
// (ESCALATION) both reattach through here (docs/loom-model.md §5). No moat
// surface: it never writes, never accepts — it just returns the most-recent
// non-archived chat of the requested role anchored to this loom (shaped as an
// InitialChat) so a reload/tab-switch/navigate-away-and-back re-attaches to
// the SAME session instead of starting fresh. `?role=` selects which
// (defaults to "steerer", the Chat tab's original caller); anything other
// than "escalation" collapses to "steerer" so a bad param fails safe.
// `{ chat: null }` when there is none (or the loom is unknown) → the caller
// opens a brand-new session of that role.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const role: "steerer" | "escalation" =
    url.searchParams.get("role") === "escalation" ? "escalation" : "steerer";
  const loom = getLoom(id);
  if (!loom) return Response.json({ chat: null });

  // listChats is anchored by project and excludes archived by default; narrow
  // to this loom's sessions of the requested role, newest by updatedAt.
  const latest = listChats(loom.project)
    .filter((c) => c.role === role && c.loomId === id)
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
    // Compaction boundaries ride along with the transcript (issue #25) — a
    // steerer chat reattached here reads the same dividers as the session page.
    compactions: chat.compactions,
    loomId: chat.loomId,
    role: chat.role,
  };
  return Response.json({ chat: initial });
}
