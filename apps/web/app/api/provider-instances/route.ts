import { requestObject, requiredString, engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * The configured logins — Telar's account registry.
 *
 * THE LIST AND ITS PROBE ARRIVE TOGETHER, in one call, because a settings row
 * needs both to render at all. Two round trips would let the page paint a green
 * dot beside an instance the second call is about to report missing.
 *
 * `?refresh=1` IS THE ONLY WAY PAST THE VERSION CACHE, and the surface sends it
 * only from a button a human pressed — the same rule the GitHub reads follow.
 * Probing costs a subprocess per driver, which is fine for a gesture and wrong
 * for a repaint.
 *
 * NOTHING HERE SIGNS ANYONE IN and no route ever will: an instance names a
 * folder the user has already authenticated with their own CLI. Sensitive
 * environment values never come back — the engine redacts them on this read,
 * which is why the whole record can be handed to a browser.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    return Response.json(await (await engineClient()).listProviderInstances({ refresh }));
  } catch (error) {
    return engineErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await requestObject(request);
    // Every optional field is forwarded VERBATIM, an explicit `null` included:
    // the engine owns the clear / keep / set rule, and a route that coerced
    // null away here would make "remove the accent colour" unexpressible.
    const result = await (await engineClient()).saveProviderInstance({
      id: requiredString(body.id, "Instance id"),
      ...(body.driver === undefined ? {} : { driver: body.driver as never }),
      ...(body.displayName === undefined ? {} : { displayName: body.displayName as string | null }),
      ...(body.accentColor === undefined ? {} : { accentColor: body.accentColor as string | null }),
      ...(body.configDir === undefined ? {} : { configDir: body.configDir as string | null }),
      ...(body.binaryPath === undefined ? {} : { binaryPath: body.binaryPath as string | null }),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.env === undefined ? {} : { env: body.env as never }),
    });
    return Response.json(result);
  } catch (error) {
    return engineErrorResponse(error);
  }
}
