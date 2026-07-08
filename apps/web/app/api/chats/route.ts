import { listChats } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? undefined;
  const raw = url.searchParams.get("archived");
  const archived = raw === "include" || raw === "only" ? raw : "exclude";
  return Response.json({ chats: listChats(project, { archived }) });
}
