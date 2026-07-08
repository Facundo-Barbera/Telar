import { deleteChat, getChat } from "@/lib/store";

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

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  deleteChat(id);
  return new Response(null, { status: 204 });
}
