import {
  activeLoomIds,
  listAccounts,
  listLooms,
  loadPolicy,
  startLoom,
  type StartLoomInput,
} from "@telar/core";

export const dynamic = "force-dynamic";

// Mirrors LoomKind — the executor's MAX_TURNS only knows these, so reject others
// up front rather than letting createLoom store a loom the executor can't drive.
const LOOM_KINDS = new Set<StartLoomInput["kind"]>([
  "quickfix",
  "story",
  "custom",
  "verify",
]);
const LOOM_TARGETS = new Set(["dev", "preview", "prod"]);

export async function GET() {
  // A Loom is the listed unit. Its weaves (threads) are first-class child looms
  // shown INSIDE the god-view (via /api/looms/[id]/threads), never as separate
  // top-level entries — so the list is roots only (no parentLoomId).
  const looms = listLooms().filter((l) => !l.parentLoomId);
  return Response.json({ looms, active: activeLoomIds() });
}

// Fire-and-forget: startLoom persists the queued loom and returns immediately while
// the executor weaves in the background. errors here are registry/validation only.
export async function POST(req: Request) {
  let body: Partial<StartLoomInput>;
  try {
    body = (await req.json()) as Partial<StartLoomInput>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.project !== "string" || !body.project.trim()) {
    return Response.json({ error: "A project is required." }, { status: 400 });
  }
  if (!LOOM_KINDS.has(body.kind as StartLoomInput["kind"])) {
    return Response.json({ error: "Invalid loom kind." }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return Response.json({ error: "A prompt is required." }, { status: 400 });
  }
  // Optional — the Verifier checks each criterion after the loom. Must be an
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
  // verify looms are read-only judgments against acceptanceCriteria — without
  // any, there's nothing for the Verifier to check.
  if (
    body.kind === "verify" &&
    (!Array.isArray(body.acceptanceCriteria) || body.acceptanceCriteria.length === 0)
  ) {
    return Response.json(
      { error: "A verify loom needs acceptanceCriteria." },
      { status: 400 },
    );
  }
  if (body.maxAttempts !== undefined) {
    if (!Number.isInteger(body.maxAttempts) || body.maxAttempts < 1) {
      return Response.json(
        { error: "maxAttempts must be an integer >= 1." },
        { status: 400 },
      );
    }
  }
  if (body.target !== undefined && !LOOM_TARGETS.has(body.target)) {
    return Response.json(
      { error: "target must be one of dev, preview, prod." },
      { status: 400 },
    );
  }
  const input = body as StartLoomInput;

  try {
    const accounts = Object.fromEntries(listAccounts().map((a) => [a.name, a]));
    const loom = startLoom(input, { accounts, policy: loadPolicy() });
    return Response.json({ loom });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
