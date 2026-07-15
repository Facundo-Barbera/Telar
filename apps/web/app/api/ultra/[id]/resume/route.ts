import { getAccount, getProject, resumeUltraRun, type AccountProfile } from "@telar/core";

export const dynamic = "force-dynamic";

// Re-run a (possibly edited) script under an existing runId, serving the
// journal prefix by ordinal (doc §3/§5's `/api/ultra/[id]/resume POST`) — the
// standard Stop → edit → resume surgery. The body is entirely optional: a
// bare POST replays the persisted script.js and inherits the original
// project/account (resumeUltraRun's own fallback, storage.ts) — the resume
// story doc §6.7 shows on a `stopped`/`failed` card's Resume affordance,
// which sends no body at all.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { script?: unknown; project?: unknown; account?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.script !== undefined && typeof body.script !== "string") {
    return Response.json({ error: "script must be a string." }, { status: 400 });
  }

  let project: string | undefined;
  if (body.project != null) {
    if (typeof body.project !== "string") {
      return Response.json({ error: "project must be a string." }, { status: 400 });
    }
    try {
      project = getProject(body.project).manifest.root;
    } catch {
      return Response.json({ error: `Unknown project "${body.project}".` }, { status: 400 });
    }
  }

  let account: AccountProfile | undefined;
  if (body.account != null) {
    if (typeof body.account !== "string") {
      return Response.json({ error: "account must be a string." }, { status: 400 });
    }
    account = getAccount(body.account);
    if (!account) {
      return Response.json({ error: `Unknown account "${body.account}".` }, { status: 400 });
    }
  }

  const result = await resumeUltraRun(id, {
    script: body.script as string | undefined,
    project,
    account,
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ runId: result.runId, meta: result.meta });
}
