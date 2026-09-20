import { requestObject, requiredString, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Open a pull request for this session's branch — issue #670.
 *
 * A SECOND ARM, NOT THE SECOND HALF OF A PUSH. Pushing needs `git` and a remote;
 * this needs `gh` and a GitHub one. #670's investigation is explicit that
 * folding them into one gesture makes the portable half hostage to the
 * unportable one — a GitLab user who can push perfectly well would get one
 * button that cannot work in place of one that can — so they are two routes and
 * two arms on the Diff surface.
 *
 * THE HEAD BRANCH IS NOT IN THE BODY. It is the session's, read off the record
 * by the engine, for the push route's reason. The TITLE and DESCRIPTION are the
 * reader's words, and the BASE is the reader's choice, defaulted by the engine
 * to the remote's own default branch and validated there as a ref name before it
 * reaches an argv.
 *
 * A REFUSAL IS A 200. "This branch is not pushed yet", "one is already open" and
 * "you cannot open one here" are answers about the repository; the surface shows
 * them, and `exists` carries the link to the pull request that already exists.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const [{ sessionId }, body] = await Promise.all([context.params, requestObject(request)]);
    const result = await (await engineClient()).openSessionPullRequest(sessionId, {
      title: requiredString(body.title, "Pull request title"),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(typeof body.base === "string" && body.base.trim() ? { base: body.base } : {}),
    });
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
