import { cancelWatch, listWatches } from "@telar/core";

export const dynamic = "force-dynamic";

// A session's active loom watches (docs/watchers-design.md §4-6). The client
// reads this on mount to re-attach its background subscribers to the watches
// the agent registered via `watch_loom`, so a state change missed while the tab
// was closed is caught the moment the loom SSE re-connects.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return Response.json({ watches: listWatches(sessionId) });
}

// Cancel a single watch by id (?id=watch_...). Returns whether it existed.
export async function DELETE(
  req: Request,
  _ctx: { params: Promise<{ sessionId: string }> },
) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  return Response.json({ cancelled: cancelWatch(id) });
}
