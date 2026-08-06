import { splitLaneIntoNew } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.sourceKey !== "string" || !body.sourceKey.trim()) {
    return Response.json({ error: "sourceKey is required." }, { status: 400 });
  }
  if (typeof body.label !== "string" || !body.label.trim()) {
    return Response.json({ error: "A label is required." }, { status: 400 });
  }
  if (typeof body.window !== "string" || !body.window.trim()) {
    return Response.json({ error: "A window is required." }, { status: 400 });
  }
  if (!Array.isArray(body.itemIds) || !body.itemIds.every((x: unknown) => typeof x === "string")) {
    return Response.json({ error: "itemIds must be an array of strings." }, { status: 400 });
  }
  try {
    const { source, created } = splitLaneIntoNew(
      body.sourceKey,
      {
        label: body.label,
        window: body.window,
        ...(typeof body.note === "string" && body.note.trim() ? { note: body.note } : {}),
      },
      body.itemIds,
    );
    return Response.json({ source, created });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
