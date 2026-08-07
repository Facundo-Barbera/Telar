import { deleteAttachmentsForChat } from "@/lib/attachments";
import { stopChatRun } from "@/lib/chat-runs";
import { repairInterruptedSession } from "@/lib/server/session-repair";
import { closeSessionRuntime } from "@/lib/server/session-runtime";
import {
  deleteChat,
  getChat,
  setChatArchived,
  setChatRead,
  setChatSettled,
  setChatSnoozed,
  setChatTitle,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Before the read: a turn the server died under must say so in the
  // transcript this response carries (see session-repair.ts). No-op for
  // live, gracefully-closed, or already-repaired sessions.
  repairInterruptedSession(id);
  const chat = getChat(id);
  if (!chat) return new Response("not found", { status: 404 });
  return Response.json(chat);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Every shape below is mutually exclusive in practice; the order here is the
  // tie-break for a caller that somehow sends two at once. Rename stays first
  // because it is the only one whose payload can fail validation.
  if (typeof body?.title === "string") {
    const title = body.title.trim();
    if (title.length < 1 || title.length > 120) {
      return Response.json(
        { error: "title must be 1..120 characters." },
        { status: 400 },
      );
    }
    if (!setChatTitle(id, title, { custom: true })) {
      return new Response("not found", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  // Inbox state. `settled` rests a row, `snoozeUntil` defers it to a wall-clock
  // time (null clears), `read` drives the unread dot. All three are separate
  // from `archived`, which stays the harder "hide this" it has always been.
  if (typeof body?.settled === "boolean") {
    if (!setChatSettled(id, body.settled)) {
      return new Response("not found", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  if (body?.snoozeUntil !== undefined) {
    const until = body.snoozeUntil;
    if (until !== null && (typeof until !== "number" || !Number.isFinite(until))) {
      return Response.json(
        { error: "snoozeUntil must be an epoch-ms number or null." },
        { status: 400 },
      );
    }
    if (!setChatSnoozed(id, until)) {
      // Either the id is unknown or the instant has already passed. The client
      // computes these from presets against its own clock, so a stale tab can
      // legitimately land one in the past — say which, rather than 404-ing a
      // session that exists.
      if (!getChat(id)) return new Response("not found", { status: 404 });
      return Response.json(
        { error: "snoozeUntil must be in the future." },
        { status: 400 },
      );
    }
    return Response.json({ ok: true });
  }

  if (typeof body?.read === "boolean") {
    if (!setChatRead(id, body.read)) {
      return new Response("not found", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  if (typeof body?.archived !== "boolean") {
    return Response.json(
      { error: "one of title, archived, settled, snoozeUntil, read is required." },
      { status: 400 },
    );
  }
  if (!setChatArchived(id, body.archived)) {
    return new Response("not found", { status: 404 });
  }
  // ARCHIVING IS DESTRUCTIVE FOR ATTACHMENTS, and deliberately one-way (owner's
  // call, 2026-08-04): the bytes die with the archive and un-archiving does not
  // bring them back. The transcript keeps each attachment's name/type/size, so
  // the messages still render — as tombstone chips with nothing behind them.
  // Only on the way IN, so a subsequent un-archive isn't a second sweep of
  // attachments a later turn may have added.
  if (body.archived) deleteAttachmentsForChat(id);
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Teardown BEFORE deletion, same pair as /api/chat/stop: the persistent
  // runtime (and any background agents it is hosting) is keyed by this id and
  // outlives its turns, so deleting only the files left a warm process — and
  // its agents — running for a session that no longer exists, still writing
  // into the deleted chat's logs. A run mid-turn is stopped by the same call.
  stopChatRun(id, "api/chats/delete");
  closeSessionRuntime(id);
  deleteChat(id);
  deleteAttachmentsForChat(id);
  return new Response(null, { status: 204 });
}
