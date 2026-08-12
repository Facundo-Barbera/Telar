import { getProject } from "@telar/core";
import { setIssueState, parsePositiveInt } from "@/lib/server/git-tab";

export const dynamic = "force-dynamic";

// POST /api/projects/[name]/git/remote/issues/[number]/state — close/reopen.
// Body: { state: "open" | "closed" } (the desired next state).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string; number: string }> },
) {
  const { name, number } = await params;

  let entry;
  try {
    ({ entry } = getProject(name));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }

  const n = parsePositiveInt(number);
  if (n === null) {
    return Response.json({ error: "Invalid issue number." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || (body.state !== "open" && body.state !== "closed")) {
    return Response.json(
      { error: "state must be 'open' or 'closed'." },
      { status: 400 },
    );
  }

  try {
    return Response.json(await setIssueState(entry.root, n, body.state));
  } catch {
    return Response.json({ connected: false, reason: "gh-error" });
  }
}
