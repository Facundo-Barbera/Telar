import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
import type { ProviderDriverKind } from "@telar/engine-client";

/**
 * Update the CLI behind a driver.
 *
 * THE DRIVER NAME IS THE WHOLE INPUT. There is no body, and there is no command
 * anywhere in this request — the engine derives what to run from the install it
 * detected on disk. A route that forwarded a command string would turn a
 * settings button into a remote shell, and this cockpit has no login.
 *
 * IT IS A DRIVER RATHER THAN AN INSTANCE because the binary is what changes.
 * Every login of a provider runs the same executable, so every one of their
 * rows moves together — which is why the fresh probes come back in the answer
 * rather than being left for the page to re-fetch.
 *
 * SLOW ON PURPOSE: `npm install -g` on a cold cache is not quick, and the
 * engine caps it at five minutes. The caller shows a spinner rather than
 * inventing a job to poll.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ driver: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { driver } = await context.params;
    // Validated at the engine, which owns the list of drivers it can run. This
    // cast only satisfies the client's type; an unknown name comes back a 404.
    return Response.json(await (await engineClient()).updateProviderCli(driver as ProviderDriverKind));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
