import pkg from "../../../package.json" with { type: "json" };
import { engineRootFromWebEnv } from "@/lib/engine/engine-server";

/**
 * The two facts About needs, and NEITHER OF THEM NEEDS THE ENGINE.
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
  return Response.json({ appVersion: pkg.version, ...(stateRoot ? { stateRoot } : {}) });
}
