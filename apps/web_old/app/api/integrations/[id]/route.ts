import { integrationServerAdapter } from "@/lib/integrations/server-registry";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const adapter = integrationServerAdapter(id);
  if (!adapter) return Response.json({ error: "Unknown integration." }, { status: 404 });
  return Response.json({ integration: adapter.definition, status: await adapter.readStatus() });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const adapter = integrationServerAdapter(id);
  if (!adapter) return Response.json({ error: "Unknown integration." }, { status: 404 });
  if (!adapter.configure) {
    return Response.json({ error: "This integration has no configurable settings." }, { status: 405 });
  }
  const input = await request.json().catch(() => null);
  const result = await adapter.configure(input);
  return Response.json(result.value, { status: result.statusCode });
}
