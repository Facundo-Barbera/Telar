import { getAccount, getProject, launchUltra, listUltraRuns, type AccountProfile } from "@telar/core";

export const dynamic = "force-dynamic";

// The rail's Workflows list (doc §6.3) — every run across every session,
// newest-first (listUltraRuns' own sort). Self-healing: a manifest still
// claiming `running` with no live task in THIS process reconciles to
// `stopped` on read (doc §3's startup-reconciliation, folded into every
// getUltraManifest call — see storage.ts).
export async function GET() {
  return Response.json({ runs: listUltraRuns() });
}

// Cut U4-B's launch route (doc §5's `/api/ultra POST` — "validate + create +
// start a run"). Called by the `ultra` MCP tool handler in a later cut (U5);
// for now a plain JSON POST. Non-blocking (doc §4): validates synchronously
// via launchUltra (which itself compiles the script before ever touching
// disk) and returns {runId} the instant the run is seeded — the run
// continues in this process after the response, detached, exactly like
// startLoom's fire-and-forget (apps/web/app/api/looms/route.ts) or the chat
// route's registerChatRun.
export async function POST(req: Request) {
  let body: {
    script?: unknown;
    args?: unknown;
    project?: unknown;
    account?: unknown;
    sessionId?: unknown;
    messageId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.script !== "string" || !body.script.trim()) {
    return Response.json({ error: "A script is required." }, { status: 400 });
  }
  if (typeof body.project !== "string" || !body.project.trim()) {
    return Response.json({ error: "A project is required." }, { status: 400 });
  }
  let root: string;
  try {
    root = getProject(body.project).manifest.root;
  } catch {
    return Response.json({ error: `Unknown project "${body.project}".` }, { status: 400 });
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
  if (body.sessionId != null && typeof body.sessionId !== "string") {
    return Response.json({ error: "sessionId must be a string." }, { status: 400 });
  }
  if (body.messageId != null && typeof body.messageId !== "string") {
    return Response.json({ error: "messageId must be a string." }, { status: 400 });
  }

  const result = await launchUltra({
    script: body.script,
    args: body.args,
    project: root,
    account,
    sessionId: body.sessionId as string | undefined,
    messageId: body.messageId as string | undefined,
  });

  // A compile-reject (doc §4: back to the agent, never the user) — plain 400,
  // same shape as every other validation failure on this route. The richer
  // {kind,detail,line} structured reject the `ultra` tool itself surfaces to
  // the authoring agent is U5's concern (the tool handler wraps this route).
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json({ runId: result.runId, meta: result.meta });
}
