import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * RECONCILE-ON-LOOK — run `gh` NOW against the subject's terrain and answer
 * with the fresh look. THE CALLER IS THE TRIGGER: the room fires this on
 * arrival and on focus, never a timer — pull-never-push, `docs/spool-loops.md`
 * §4.
 *
 * IT NEVER 5XXES FOR THE WORLD BEING UNREACHABLE. `gh` failing comes back as
 * 200 with `{fresh: false, error}` beside the stale look, and a subject with
 * no terrain answers `{note}` — both are answers a surface renders honestly,
 * not faults to swallow.
 */
export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const subject = typeof body.subject === "string" ? body.subject : body.subjectKey;
    if (typeof subject !== "string" || !subject) {
      return Response.json({ error: "subject is required." }, { status: 400 });
    }
    return Response.json(await (await engineClient()).reconcileSpoolLook(subject));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
