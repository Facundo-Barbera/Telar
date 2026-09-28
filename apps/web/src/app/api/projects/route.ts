import { optionalString, requestObject, requiredString, engineClient, engineRoute } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = engineRoute(async (request: Request) => {
  // `?includeRemoved=1` is forwarded, not inferred: every existing caller
  // asks without it and keeps getting only the live registry.
  const includeRemoved = new URL(request.url).searchParams.get("includeRemoved") === "1";
  return Response.json(await (await engineClient()).listProjects({ includeRemoved }));
});

export const POST = engineRoute(async (request: Request) => {
  const body = await requestObject(request);
  const result = await (await engineClient()).registerProject({
    id: optionalString(body.id, "Project id"),
    name: requiredString(body.name, "Project name"),
    root: requiredString(body.root, "Project root"),
  });
  return Response.json(result, { status: 201 });
});
