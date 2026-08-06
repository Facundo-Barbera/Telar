import { createWorkspaceLane } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

// NFR-OW-10 reserves lane structure to the human. This route (and every other
// one under app/api/workspace/lanes/**) is reached only by the queue view's
// own lane-management UI — never by an MCP tool.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.label !== "string" || !body.label.trim()) {
    return Response.json({ error: "A label is required." }, { status: 400 });
  }
  if (typeof body.window !== "string" || !body.window.trim()) {
    return Response.json({ error: "A window is required." }, { status: 400 });
  }
  const lane = createWorkspaceLane({
    label: body.label,
    window: body.window,
    ...(typeof body.note === "string" && body.note.trim() ? { note: body.note } : {}),
  });
  return Response.json({ lane });
}
