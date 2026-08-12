import { readUltraScript } from "@telar/core";

export const dynamic = "force-dynamic";

// Story 4.2 — the bytes behind the rail's Script tab.
//
// `readUltraScript` has existed since cut U4-B and had NO HTTP SURFACE: its only
// callers were `resumeUltraRun` and a test. The read-only Script tab
// (`ui-contract.md` §3, "A Script tab shows the script read-only (model pins
// visible)") has no other data source, so this route is the whole of it.
//
// READ-ONLY BY CONSTRUCTION. There is no PUT here and there must not be one: the
// script is the INPUT to a resume, so editing it from the UI would be a
// repo-mutating action with no approval path — the moat's posture, applied one
// level down.
//
// 404 when there is no script, rather than `{ script: null }`, because "this run
// has no persisted script" and "this run does not exist" are the same answer to
// the tab and both mean "nothing to show". Wrapped exactly as
// `wakes/route.ts` wraps its read (§5.6-T8) — a run directory that cannot be
// read must not 500 the session.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let script: string | null = null;
  try {
    script = readUltraScript(id);
  } catch {
    script = null;
  }
  if (script === null) {
    return Response.json({ error: `No script on disk for run "${id}".` }, { status: 404 });
  }
  return Response.json({ script });
}
