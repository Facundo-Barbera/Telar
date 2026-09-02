import pkg from "../../../package.json" with { type: "json" };
import { buildIdentity } from "@/lib/build-identity";
import { engineRootFromWebEnv } from "@/lib/engine/engine-server";

/**
 * The facts About needs, and NONE OF THEM NEED THE ENGINE.
 *
 * Separate from `/api/health` on purpose. Health 4xxs when the engine is down —
 * which is correct, and which its caller (the projects cockpit) depends on to
 * show an error state. But "which build is this" and "where does its state
 * live" are exactly the questions worth answering WHEN the engine is down, so
 * folding them into a route that fails together would make them unavailable
 * precisely when they matter.
 *
 * The state root is a fact about how this process was started, not something
 * the engine reports.
 *
 * `appName`, `channel` and `iconUrl` are the same kind of fact, added for the
 * paired clients: a phone holding three Telars in a list has nothing but this
 * route to tell them apart with, and "0.1.0" three times is not an answer. They
 * come off the packaging artefacts on disk (lib/build-identity.ts), which is
 * why they survive a dead engine too.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const stateRoot = (() => {
    try {
      return engineRootFromWebEnv();
    } catch {
      // The launcher refuses a legacy or relative TELAR_HOME before Next boots,
      // so this is only reachable in an odd embedding. Absent beats a guess.
      return undefined;
    }
  })();
  const { appName, channel, icon } = buildIdentity();
  return Response.json({
    appVersion: pkg.version,
    appName,
    channel,
    // OMITTED RATHER THAN GUESSED, like the state root above: an embedding with
    // no icon on disk would otherwise advertise a URL that 404s, and a client
    // cannot tell that apart from a broken instance. The `?v=` is what earns the
    // icon route its immutable cache.
    ...(icon ? { iconUrl: `/api/about/icon?v=${icon.key}` } : {}),
    ...(stateRoot ? { stateRoot } : {}),
  });
}
