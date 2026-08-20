import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One subject's map. */
export async function GET(_request: Request, { params }: { params: Promise<{ subject: string }> }) {
  try {
    const { subject } = await params;
    return Response.json(await (await engineClient()).spoolThreads(subject));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

/**
 * MAP THIS SUBJECT — and it answers with the WORK RECORD, not the result.
 *
 * The expert route learned this the expensive way and its header still says so:
 * a pass that runs for minutes behind a synchronous POST is a request the
 * browser abandons while the daemon keeps spending. The caller polls
 * `/api/spool/work`, where this pass is addressed by SUBJECT.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ subject: string }> }) {
  try {
    const { subject } = await params;
    return Response.json(await (await engineClient()).startSpoolThreadPass(subject));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
