import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The CLIProxyAPI hubs quota is read from — configuration, not quota.
 *
 * MANAGEMENT KEYS NEVER COME BACK THROUGH HERE. The engine's list read is the
 * redacting one; this route has no way to ask for the other, which is the point
 * of splitting them there rather than remembering to redact here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await (await engineClient()).usageLimitSources());
  } catch (error) {
    return engineErrorResponse(error);
  }
}
