import { listChats } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get("project") ?? undefined;
  return Response.json({ chats: listChats(project) });
}
