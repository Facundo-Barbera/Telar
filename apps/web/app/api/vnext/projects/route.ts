import {
  optionalString,
  requestObject,
  requiredString,
  vnextEngine,
  vnextErrorResponse,
} from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await vnextEngine()).listProjects());
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const result = await (await vnextEngine()).registerProject({
      id: optionalString(body.id, "Project id"),
      name: requiredString(body.name, "Project name"),
      root: requiredString(body.root, "Project root"),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
