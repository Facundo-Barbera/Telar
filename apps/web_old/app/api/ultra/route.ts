import {
  getAccount,
  getProject,
  launchUltra,
  listUltraRuns,
  ultraRunLabel,
  type AccountProfile,
} from "@telar/core";
import { filterRunsBySession } from "@/lib/ultra-runs";

export const dynamic = "force-dynamic";

// The rail's Workflows list (doc §6.3) — every run across every session,
// newest-first (listUltraRuns' own sort). Self-healing: a manifest still
// claiming `running` with no live task in THIS process reconciles to
// `stopped` on read (doc §3's startup-reconciliation, folded into every
// getUltraManifest call — see storage.ts).
//
// STORY 4.2 ADDED THREE THINGS AND NOTHING ELSE.
//
// 1. `?sessionId=` — filtered SERVER-SIDE. Three reasons in order of weight:
//    `run.sessionId` is optional (a run launched outside a chat has none) so the
//    test must be DEFINED-AND-EQUAL and never truthy; a session-scoped payload
//    is what makes the rail's poll cheap; and it bounds the response without
//    removing the directory walk (the `sessionId → runIds` storage index stays
//    an open item — see deferred-work.md).
//    The decision itself lives in `@/lib/ultra-runs`'s `filterRunsBySession`,
//    not here, and that is deliberate: THERE IS NO ROUTE-TEST HARNESS IN THIS
//    REPO (every `apps/web` spec sits under `lib/` or
//    `components/conversation/`, none under `app/`), so a filter written inline
//    would be a filter that ships unproven. This handler is a caller.
//    "Today's behaviour, unchanged, when the parameter is absent" is executable
//    as `filterRunsBySession(runs, undefined)` returning the input unchanged —
//    same runs, same order, same `{ runs }` envelope. The only additive
//    difference is `name` below.
//
// 2. `name`, RENDERED HERE. `ultraRunLabel` is a core VALUE export, so a client
//    that called it would be an INV-4c violation reported by name. Rendering it
//    server-side is what lets the rail and the dock label a run without one.
//    (`@/lib/ultra-runs` carries a four-line copy of the same rule for the
//    stream-only window, because the SSE frames are the bare `UltraManifest` and
//    carry no `name` at all — the two are pinned against each other by a test.)
//
// 3. THE GUARD, copied from `wakes/route.ts`, which was the ONLY route in the
//    tree that wrapped this read. `listUltraRuns` → `getUltraManifest`'s
//    self-heal is an unwrapped WRITE inside a function whose contract is "never
//    a 500", so ONE malformed or unhealable manifest anywhere under
//    `TELAR_HOME/ultra/` threw for every caller of this route. Degrading to the
//    empty list says "nothing to show" without the 500; the runs are not lost,
//    because this is a projection over the manifests and it re-answers the
//    moment the root is readable again.
export async function GET(req: Request) {
  // DEFINED-AND-EQUAL, never truthy, and not trimmed to nothing: an absent
  // parameter means "every run", while `?sessionId=` present-but-empty means
  // "the session named by the empty string", which no run belongs to. Those are
  // different questions and the caller asked a different one each time.
  const raw = new URL(req.url).searchParams.get("sessionId");
  const sessionId = raw === null ? undefined : raw;
  try {
    const runs = filterRunsBySession(listUltraRuns(), sessionId).map((run) => ({
      ...run,
      name: ultraRunLabel(run.meta, run.runId),
    }));
    return Response.json({ runs });
  } catch {
    return Response.json({ runs: [] });
  }
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
  // The project's own guardrails ride along with its root — resolved from the
  // SAME lookup, so a child agent cannot end up confined to a root whose rules
  // nobody read. Enforced on every child through the Ultra PreToolUse hook
  // (packages/core/src/ultra/child-guard.ts); before that hook existed,
  // protectedPaths/disallowedTools were a session-only promise and an Ultra
  // child could rewrite the very files a project declared off limits.
  let guardrails: { disallowedTools: string[]; protectedPaths: string[] };
  try {
    const manifest = getProject(body.project).manifest;
    root = manifest.root;
    // Defensive read — the catch below reports "unknown project", so a manifest
    // missing this field must not masquerade as a missing project.
    guardrails = {
      disallowedTools: [...(manifest.guardrails?.disallowedTools ?? [])],
      protectedPaths: [...(manifest.guardrails?.protectedPaths ?? [])],
    };
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
    guardrails: { root, guardrails },
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
