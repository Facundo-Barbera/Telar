// ONE ENDPOINT FOR BOTH HANDOFFS (story 5.5, CAP-11). A packet's own "Plan loom
// from this packet" posts one id; the queue's batch bar posts the selection.
// They are the same operation with a different member count — see
// lib/workspace-handoff.ts — so a second route would only be a second place for
// the two to drift.
//
// POST ONLY, AND THE ABSENCE OF A GET IS THE POINT. "Proposal → explicit human
// approval → effect" (ui-contract.md) already has both halves, and neither of
// them is an HTTP read: when an AGENT proposes a weave it goes through
// `mcp__workspace__weave_batch`, whose input the shared ApprovalCard renders
// before the tool ever runs; when the HUMAN proposes one they are the approver,
// and the click on "Weave as one loom" IS the approval. A GET returning
// planWeave's preview was written here first and had no reader on either path —
// a preview endpoint nobody previews from is a second definition of the plan
// waiting to disagree with the one that runs. planWeave stays the pure half of
// lib/workspace-handoff.ts (and is tested there); it is simply not a URL.
//
// NO `by` IS READ FROM THE BODY. This route performs no accept and no commit —
// it plans a DRAFT loom (never startLoomFromBundle) — so there is no provenance
// stamp to forge. The one thing it does write outside the loom's bundle is
// Item.tracking, which is a mark on a row that stays in the queue.
import { HandoffRefused, weaveItems } from "@/lib/workspace-handoff";

export const dynamic = "force-dynamic";

// BOUNDED, LIKE EVERY OTHER REFUSAL HERE IS EXPLICIT. A weave reads one packet
// directory per id and writes every one of them into a single objective.md, so
// an unbounded array is 2N disk reads and a bundle file nothing can read. The
// ceiling is far above any real selection (the queue is a human's stack, not a
// dataset) and exists so the failure is a sentence rather than a stalled
// request. The per-element cap is the same argument at the other scale: an item
// id is a slug, and a megabyte-long one is not a typo.
const MAX_ITEMS = 100;
const MAX_ID_LENGTH = 200;

function idsFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_ITEMS) return null;
  if (!value.every((x) => typeof x === "string" && x.length <= MAX_ID_LENGTH)) return null;
  return value as string[];
}

const failed = (error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    // A refusal is the caller asking for something the moat or the model of the
    // store forbids (400); anything else is this server failing (500), and the
    // two must not read the same to the surface showing them. The refusal's own
    // sentence is the product — it names the floating row, the second project or
    // the loom already tracking, and lands verbatim in the batch bar.
    { status: error instanceof HandoffRefused ? 400 : 500 },
  );

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const ids = idsFrom(body?.itemIds);
  if (!ids) {
    return Response.json(
      {
        error: `itemIds must be an array of at most ${MAX_ITEMS} item id strings (each at most ${MAX_ID_LENGTH} characters).`,
      },
      { status: 400 },
    );
  }
  try {
    return Response.json(
      weaveItems(ids, {
        ...(typeof body.reason === "string" && body.reason.trim() ? { reason: body.reason } : {}),
        ...(typeof body.title === "string" && body.title.trim() ? { title: body.title } : {}),
      }),
    );
  } catch (error) {
    return failed(error);
  }
}
