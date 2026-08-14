import {
  optionalString,
  requestObject,
  requiredString,
  engineClient,
  engineErrorResponse,
} from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).listProjects());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await requestObject(request);
    const result = await (await engineClient()).registerProject({
      id: optionalString(body.id, "Project id"),
      name: requiredString(body.name, "Project name"),
      root: requiredString(body.root, "Project root"),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return engineErrorResponse(error);
  }
}
