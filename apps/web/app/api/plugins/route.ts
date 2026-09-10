import { engineClient, engineErrorResponse, requestObject } from "@/lib/engine/engine-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * WHAT THIS MAC ALLOWS. Scoped to the engine this request resolves to — a
 * cockpit viewing another Mac reaches that Mac's daemon, so a global switch is
 * never accidentally flipped on the machine the browser happens to run beside.
 */
export async function GET() {
  try {
    return Response.json(await (await engineClient()).machinePlugins());
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const input = await requestObject(request);
    // Shape and per-plugin schema validation are the ENGINE's: it holds the
    // plugin whose settings these are, and duplicating the check here would be
    // a second place to get it wrong.
    return Response.json(
      await (await engineClient()).updateMachinePlugins(
        input.plugins as Record<string, { enabled: boolean; settings?: Record<string, unknown> } | null>,
      ),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
