import { listUltraAgentOrdinals, readUltraAgentTranscript, readUltraEvents } from "@telar/core";

export const dynamic = "force-dynamic";

// Story 4.2 — THE AGENT INDEX. Which ordinals have begun, what each last said,
// and whether it has settled. The rail's LIVE agent rows have no other source.
//
// AN INDEX BESIDE A DYNAMIC CHILD. This sits at `…/[id]/agents` with
// `…/[id]/agents/[ordinal]` beneath it; the two match different path depths and
// do not compete. (That is a different case from `wakes/` — a STATIC segment
// sibling to a dynamic one — which story 4.1 relied on.) Per
// `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`,
// `params` is a PROMISE and is awaited.
//
// WHY EACH FIELD COMES FROM WHERE IT DOES, because two of the three are not
// where a reader would first look:
//
//   `ordinal` — `listUltraAgentOrdinals`, a directory listing of `agents/`. A
//   file there means the ordinal has STREAMED AT LEAST ONE ENGINE EVENT, which
//   happens while it is still working.
//
//   `settled` — NEITHER of the two agent readers can answer this. Settlement IS
//   the `agent` UltraEvent on `events.ndjson`, which is the entire reason story
//   4.2 had to add `agent-start` in the first place: before it, "has begun" and
//   "has settled" were the same observation.
//
//   `lastText` — the last `{ type: "text" }` record whose `attempt` equals the
//   MAXIMUM attempt present. Two traps in one field. `UltraAgentEventRecord` is
//   `EngineEvent & { attempt; ts }`, and `EngineEvent`'s five variants
//   (`session | text | tool | tool-result | result`) leave `text` as the only
//   prose-bearing one — so a naive "last record" yields a `result` frame with no
//   text at all. And a RETRIED ordinal's attempt-1 text is DISCARDED WORK: the
//   run took attempt 2's answer, so showing attempt 1's is showing the wrong
//   thing.
//
// Empty, never 404, for a run with no agents yet — the same "not there yet"
// tolerance the events SSE route and the `[ordinal]` route already have, since a
// client may poll this before the run directory exists. And the whole read is
// wrapped exactly as `wakes/route.ts` wraps its own (§5.6-T8): one malformed
// manifest under the ultra root must not 500 a poll.

/** A snippet, not a transcript — the rail row is one truncated line. Truncated
 *  by CODE POINT (`Array.from`), never `.slice()`, which splits astral
 *  characters in half; `tool-step.tsx`'s `stepPreview` and `items.ts`'s
 *  `agentLabel` both say so where they do the same thing. */
const SNIPPET_CAP = 200;
function snippet(text: string): string {
  const points = Array.from(text);
  return points.length > SNIPPET_CAP ? `${points.slice(0, SNIPPET_CAP).join("")}…` : points.join("");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const settled = new Set<number>();
    for (const e of readUltraEvents(id, 0).events) {
      if (e.type === "agent") settled.add(e.ordinal);
    }
    const agents = listUltraAgentOrdinals(id).map((ordinal) => {
      const records = readUltraAgentTranscript(id, ordinal);
      const attempt = records.reduce((max, r) => (r.attempt > max ? r.attempt : max), 0);
      let lastText = "";
      for (const r of records) {
        if (r.attempt === attempt && r.type === "text") lastText = r.text;
      }
      return { ordinal, settled: settled.has(ordinal), attempt, lastText: snippet(lastText) };
    });
    // AN ENVELOPE, NEVER A BARE ARRAY (§5.6-T16's rule applied to a route this
    // story mints): every other ultra route answers `{ run }` / `{ runs }`, and
    // one route answering an array is the shape that gets unwrapped at the wrong
    // level exactly once.
    return Response.json({ agents });
  } catch {
    return Response.json({ agents: [] });
  }
}
