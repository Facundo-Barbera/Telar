import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";

/**
 * Update the CLI behind one login.
 *
 * THE INSTANCE ID IS THE WHOLE INPUT. There is no body, and there is no command
 * anywhere in this request — the engine resolves which binary that login runs
 * and derives what would update it from the install it finds on disk. A route
 * that forwarded a command string would turn a settings button into a remote
 * shell, and this cockpit has no login.
 *
 * IT IS A LOGIN RATHER THAN A DRIVER because a login can pin its own binary.
 * Keyed on the driver, pressing Update on the row pinned to a beta build would
 * have updated the default install instead and reported success — the worst
 * shape of wrong, since the number on screen would then be right about a binary
 * that row does not run.
 *
 * SLOW ON PURPOSE: `npm install -g` on a cold cache is not quick, and the
 * engine caps it at five minutes. The caller shows a spinner rather than
 * inventing a job to poll.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ instanceId: string }> };

export async function POST(_request: Request, context: Context) {
  try {
    const { instanceId } = await context.params;
    return Response.json(await (await engineClient()).updateProviderCli(instanceId));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
