/**
 * THE APPEARANCE HOME, PROXIED — the files behind Settings → Appearance.
 *
 * `/api/appearance` is the MAILBOX: the resolved look this window published so
 * a paired client can wear it. This is the RECORD: the themes, looks and
 * settings on disk at `$TELAR_HOME/appearance`, which a person edits through
 * this pane and an agent edits with a text editor. Both authors, one truth.
 *
 * UNPARSED ON THE WAY THROUGH. The engine holds files it does not understand,
 * and this route does not understand them either — the vocabulary lives in
 * @telar/engine-client and runs in the browser that paints with it. A theme
 * this build cannot read is therefore still REPORTED rather than dropped in
 * transit, which is what lets the pane say "three files, one of them broken"
 * instead of quietly showing two.
 *
 * PAIRED-ONLY, like the mailbox beside it and for the same reason: this is a
 * description of somebody's machine.
 */

import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).appearanceHome());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
