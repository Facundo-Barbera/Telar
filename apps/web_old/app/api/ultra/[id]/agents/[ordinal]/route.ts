import { readUltraAgentTranscript } from "@telar/core";

export const dynamic = "force-dynamic";

// One agent's transcript for the rail's agent view (doc §5's
// `/api/ultra/[id]/agents/[ordinal] GET`) — the EngineEvent stream (text/
// tool/tool-result/result) for that ordinal, tagged with the retry `attempt`
// that produced each event (doc §3/§7-U3: a retried call's attempts never
// blur into one ambiguous stream). Empty array (never 404) for an ordinal
// that hasn't settled yet or doesn't exist — same "not there yet" tolerance
// as the events SSE route, since a client may poll this before the run dir
// exists.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; ordinal: string }> },
) {
  const { id, ordinal: ordinalRaw } = await params;
  const ordinal = Number(ordinalRaw);
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    return Response.json({ error: "ordinal must be a non-negative integer." }, { status: 400 });
  }
  const events = readUltraAgentTranscript(id, ordinal);
  return Response.json({ ordinal, events });
}
