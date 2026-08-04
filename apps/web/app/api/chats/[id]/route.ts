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
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  deleteChat(id);
  return new Response(null, { status: 204 });
}
