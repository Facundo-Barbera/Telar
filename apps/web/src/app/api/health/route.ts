import { engineClient, engineErrorResponse } from "@/platform/engine/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).health());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
