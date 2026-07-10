import {
  clearMcpToken,
  declaredMcpSecretKeys,
  hasMcpToken,
  setMcpToken,
} from "@telar/core";

export const dynamic = "force-dynamic";

// A project's MCP tokens — the secret values behind its manifest's { secret }
// refs. WRITE-ONLY: we report only WHETHER a key is filled, never its value.
// The project name is the route param (server-derived); we never trust a body.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const tokens: Record<string, boolean> = {};
  for (const key of declaredMcpSecretKeys(name)) tokens[key] = hasMcpToken(name, key);
  return Response.json({ tokens });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.key !== "string" || !body.key.trim()) {
    return Response.json({ error: "key (string) is required." }, { status: 400 });
  }
  if (typeof body?.token !== "string" || !body.token.trim()) {
    return Response.json({ error: "token (string) is required." }, { status: 400 });
  }
  setMcpToken(name, body.key, body.token);
  return Response.json({ ok: true });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.key !== "string" || !body.key.trim()) {
    return Response.json({ error: "key (string) is required." }, { status: 400 });
  }
  return Response.json({ ok: clearMcpToken(name, body.key) });
}
