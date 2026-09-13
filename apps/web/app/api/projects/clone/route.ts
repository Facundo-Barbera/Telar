import { optionalString, requestObject, requiredString, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Clone a repository into a folder somebody picked, and register what landed.
 *
 * ONE ROUTE RATHER THAN TWO, because the cockpit cannot name the path in
 * between: it sends a URL and the parent directory, and only the engine knows
 * which folder `git clone` created. A two-step version would have this adapter
 * hand back a path whose next request is "now register the thing I did not
 * choose".
 *
 * IT SITS AT `/api/projects/clone`, above the `[projectId]` segment, so the
 * word `clone` is a verb on the collection rather than a project id that happens
 * to spell one — project ids are `project_…`, so there is nothing to collide
 * with, but the shape says which it is without having to know that.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const result = await (await engineClient()).cloneProject({
      url: requiredString(body.url, "Repository URL"),
      parent: requiredString(body.parent, "Parent folder"),
      // Absent by default: the engine names the project after the folder git
      // created, which is the name the person would have typed anyway.
      ...(body.name === undefined ? {} : { name: optionalString(body.name, "Project name")! }),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
