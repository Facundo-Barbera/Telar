import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The logins a person allowed agents to fill without being asked again.
 *
 * READ ONLY HERE — there is no POST, deliberately. A grant is created in
 * exactly one way: an unchecked box ticked on a `secret_access` approval card,
 * with the page and the item in front of the person. A route that could mint
 * one would be a way to hand out vault access at a distance.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).browserLogins());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
