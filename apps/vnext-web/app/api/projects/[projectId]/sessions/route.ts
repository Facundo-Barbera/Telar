import {
  optionalString,
  requestObject,
  vnextEngine,
  vnextErrorResponse,
} from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { projectId } = await context.params;
    return Response.json(await (await vnextEngine()).listSessions(projectId));
  } catch (error) {
    return vnextErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const [{ projectId }, body] = await Promise.all([context.params, requestObject(request)]);
    const result = await (await vnextEngine()).createSession({
      id: optionalString(body.id, "Session id"),
      projectId,
      title: optionalString(body.title, "Session title"),
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
