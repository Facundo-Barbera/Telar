import { vnextEngine, vnextErrorResponse } from "@/lib/vnext/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await vnextEngine()).health());
  } catch (error) {
    return vnextErrorResponse(error);
  }
}
