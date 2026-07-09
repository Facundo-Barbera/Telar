import {
  activeRunIds,
  listAccounts,
  listRuns,
  loadPolicy,
  startRun,
  type StartRunInput,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Mirrors RunKind — the executor's MAX_TURNS only knows these, so reject others
// up front rather than letting createRun store a run the executor can't drive.
const RUN_KINDS = new Set<StartRunInput["kind"]>(["quickfix", "story", "custom"]);

export async function GET() {
  return Response.json({ runs: listRuns(), active: activeRunIds() });
}

// Fire-and-forget: startRun persists the queued run and returns immediately while
// the executor weaves in the background. errors here are registry/validation only.
export async function POST(req: Request) {
  let body: Partial<StartRunInput>;
  try {
    body = (await req.json()) as Partial<StartRunInput>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.project !== "string" || !body.project.trim()) {
    return Response.json({ error: "A project is required." }, { status: 400 });
  }
  if (!RUN_KINDS.has(body.kind as StartRunInput["kind"])) {
    return Response.json({ error: "Invalid run kind." }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return Response.json({ error: "A prompt is required." }, { status: 400 });
  }
  // Optional — the Verifier checks each criterion after the run. Must be an
  // array of non-empty trimmed strings if present.
  if (body.acceptanceCriteria !== undefined) {
    const ac = body.acceptanceCriteria;
    if (
      !Array.isArray(ac) ||
      !ac.every((c) => typeof c === "string" && c.trim() === c && c !== "")
    ) {
      return Response.json(
        { error: "acceptanceCriteria must be non-empty trimmed strings." },
        { status: 400 },
      );
    }
  }
  const input = body as StartRunInput;

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const run = startRun(input, { accounts, policy: loadPolicy() });
    return Response.json({ run });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
