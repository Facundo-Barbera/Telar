import { reorderQueueLane } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.itemIds) || !body.itemIds.every((x: unknown) => typeof x === "string")) {
    return Response.json({ error: "itemIds must be an array of strings." }, { status: 400 });
  }
  try {
    const lane = reorderQueueLane(key, body.itemIds);
    return Response.json({ lane });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
