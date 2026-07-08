import { deleteChat, getChat, setChatArchived, setChatTitle } from "@/lib/store";

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

  // Rename: { title } takes priority over { archived } when both are somehow
  // present — the two are otherwise mutually exclusive request shapes.
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

  if (typeof body?.archived !== "boolean") {
    return Response.json(
      { error: "archived (boolean) is required." },
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
