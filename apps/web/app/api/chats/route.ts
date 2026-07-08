import { listChats } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ chats: listChats() });
}
