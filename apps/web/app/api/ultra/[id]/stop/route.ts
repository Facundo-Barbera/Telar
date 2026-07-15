import { stopUltraRun } from "@telar/core";

export const dynamic = "force-dynamic";

// Aborts a live run's shared AbortController -> `stopped`, journal prefix
// kept (doc §3). Mirrors /api/looms/[id]/cancel: only works while the run's
// task is alive in THIS process — a run whose task already died (server
// restart) simply returns false; getUltraManifest's own self-healing read is
// what reconciles a stale `running` manifest to `stopped`, not this route.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return Response.json({ ok: stopUltraRun(id) });
}
