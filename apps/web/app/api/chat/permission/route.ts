import { resolvePending } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The session UI answers a pending canUseTool request from the chat stream.
export async function POST(req: Request) {
  let body: { id?: unknown; behavior?: unknown; always?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, behavior, always } = body;
  if (typeof id !== "string" || (behavior !== "allow" && behavior !== "deny")) {
    return Response.json({ error: "id and behavior allow|deny required" }, { status: 400 });
  }
  const ok = resolvePending(id, { behavior, always: !!always });
  return Response.json({ ok }); // ok:false = already resolved, timed out, or unknown
}
