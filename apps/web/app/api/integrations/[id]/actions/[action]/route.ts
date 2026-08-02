import { integrationServerAdapter } from "@/lib/integrations/server-registry";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  const adapter = integrationServerAdapter(id);
  if (!adapter) return Response.json({ error: "Unknown integration." }, { status: 404 });
  const handler = adapter.actions?.[action];
  if (!handler) return Response.json({ error: "Unknown integration action." }, { status: 404 });
  const result = await handler();
  return Response.json(result.value, { status: result.statusCode });
}
