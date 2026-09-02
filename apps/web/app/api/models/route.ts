import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * A provider's models.
 *
 * NOT PROJECT-SCOPED. A catalogue describes an installed harness, and every
 * project on this machine sees the same one — scoping it per project would
 * multiply an expensive read by the number of repositories for no difference in
 * the answer.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const driver = url.searchParams.get("driver") === "codex" ? "codex" : "claude";
    // WHICH LOGIN, for the overlay laid over the provider's answer. The answer
    // itself is still driver-wide; absent means that driver's built-in slot.
    const instanceId = url.searchParams.get("instanceId");
    return Response.json(
      await (await engineClient()).modelCatalogue(driver, {
        refresh: url.searchParams.get("refresh") === "1",
        ...(instanceId ? { instanceId } : {}),
      }),
    );
  } catch (error) {
    return engineErrorResponse(error);
  }
}
