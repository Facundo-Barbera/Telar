import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    return Response.json(await (await engineClient()).latexToolchain(fresh));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
