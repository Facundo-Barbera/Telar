import { recordHumanVerdict } from "@/lib/workspace-api";

export const dynamic = "force-dynamic";

// The human's own session-or-loom verdict (CAP-9, story 5.8).
//
// A SEPARATE ROUTE RATHER THAN A KEY ON PATCH /api/workspace/items/<id>, and the
// separation is the durability. That route's PATCHABLE_KEYS deliberately
// withholds `verdict` — a verdict written through the generic patch verb would
// set the FIELD without the flag that says a human set it, which is exactly the
// verdict a later expert pass is allowed to overwrite. Only core's
// setItemVerdict raises `verdictOverride`, and only this route calls it.
//
// IT IS NOT, AND MUST NEVER BECOME, AN MCP TOOL — the same rule the sub-task
// promote route states. apps/web/lib/workspace-mcp.ts's consult_expert takes an
// item id and nothing else; there is no tool input anywhere that can spell a
// verdict, so "a human override" cannot be forged by an agent claiming to be
// one. INV-11's pinned inventory is what keeps that true under review.
//
// NOTHING HERE ACCEPTS ANYTHING. A verdict says WHERE work would run if it ran
// — a session or a loom — and writes no status, starts nothing and completes
// nothing (the Item schema has no field for any of it). The accept moat is
// untouched.
const VERDICTS = new Set(["session", "loom"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  // UNKNOWN KEYS ARE A 400, the sibling PATCH's rule (it 400s anything outside
  // PATCHABLE_KEYS) applied to a body with exactly one admissible key. A route
  // that silently ignored `{verdict, verdictOverride:false}` — or a `deadline` a
  // later surface posted here by mistake — would report success for a write it
  // did not make.
  const extra =
    body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body).filter((k) => k !== "verdict")
      : [];
  if (extra.length > 0) {
    return Response.json({ error: `This route sets only \`verdict\`; it cannot set ${extra.join(", ")}.` }, { status: 400 });
  }
  const verdict = (body as { verdict?: unknown } | null)?.verdict;
  // The enum is spelled here rather than imported as a zod schema on purpose:
  // @telar/core owns the persisted shape (ItemVerdict) and this is argument
  // validation, the same split workspace-mcp.ts states for its own input shapes.
  // core parses it again on the way to disk, so a widening here cannot store a
  // verdict the schema does not admit.
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
    return Response.json(
      { error: `A verdict of "session" or "loom" is required.` },
      { status: 400 },
    );
  }
  // THE THROWING VERBS ARE A 400 CARRYING THE STORE'S OWN SENTENCE, exactly as
  // the sibling PATCH in this directory does it (fix-round correction — this had
  // no try/catch and the throw was an unhandled 500). `setItemVerdict` runs
  // assertPacketAddressMatches, which throws for a packet whose `id:` line
  // disagrees with its directory — a state AD-6 INVITES, since hand-editing a
  // packet is a stated product property — and `Item.parse` can throw too. The
  // store's message names the repair ("Fix the `id:` line by hand, or move the
  // directory"); a bare 500 renders in the packet view as "The verdict did not
  // change" with nothing to act on.
  try {
    const item = recordHumanVerdict(id, verdict as "session" | "loom");
    if (!item) return Response.json({ error: "Item not found." }, { status: 404 });
    return Response.json({ item });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
