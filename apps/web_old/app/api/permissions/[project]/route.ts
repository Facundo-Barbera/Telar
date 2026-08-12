import { readRules, removeRule } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// A project's always-allow permission rules — the ones "Always allow" answers
// in a session persist. GET lists them; DELETE forgets one.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ project: string }> },
) {
  const { project } = await params;
  return Response.json({ rules: readRules(project) });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ project: string }> },
) {
  const { project } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.rule !== "string" || !body.rule) {
    return Response.json({ error: "rule (string) is required." }, { status: 400 });
  }
  removeRule(project, body.rule);
  return Response.json({ ok: true });
}
