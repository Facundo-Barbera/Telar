import { repairInterruptedSession } from "@/lib/server/session-repair";
import { getChat } from "@/lib/store";
import { chatToMarkdown, transcriptFilename } from "@/lib/transcript-export";

export const dynamic = "force-dynamic";

// The transcript, as a file that leaves the app. Read from chats.json via
// getChat — the same source the session view reloads from, and the only
// complete one: the session feed keeps a single window (session-log.ts's
// startSessionFeedWindow truncates on the next), so exporting from it would
// hand over the last question and call it the conversation.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Same truth the detail GET tells: a turn the server died under must say
  // so in the file that leaves the app. No-op unless a crash left the
  // session's window unterminated (see session-repair.ts).
  repairInterruptedSession(id);
  const chat = getChat(id);
  if (!chat) return new Response("not found", { status: 404 });

  return new Response(chatToMarkdown(chat), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // transcriptFilename sanitizes to [a-z0-9-] before this line, which is
      // what makes the quoting safe — a chat title is arbitrary user text and
      // cannot be trusted next to a header delimiter.
      "Content-Disposition": `attachment; filename="${transcriptFilename(chat)}"`,
      // Unlike an attachment's bytes, a transcript grows with every turn.
      "Cache-Control": "no-store",
    },
  });
}
