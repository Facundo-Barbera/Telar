import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { engineClient, engineErrorResponse, requestObject, optionalString } from "@/lib/engine/engine-server";
import { getLoom, saveLoom } from "@/lib/looms/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ loomId: string }> };

const exec = promisify(execFile);

/** The scheduler CLI, invoked across a process boundary like any other consumer. */
const ENV_CLI = join(process.cwd(), "..", "..", "packages", "env", "src", "cli.ts");

interface TierOutput {
  ok: boolean;
  error?: string;
  run?: { output?: string };
}

async function runTier(cwd: string, tier: string): Promise<TierOutput> {
  try {
    const { stdout } = await exec("bun", [ENV_CLI, "tier", tier], { cwd, timeout: 660_000 });
    return JSON.parse(stdout) as TierOutput;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) {
      try {
        return JSON.parse(stdout) as TierOutput;
      } catch {
        // fall through to the generic failure
      }
    }
    return { ok: false, error: String(error).slice(0, 300) };
  }
}

/**
 * Run a verification tier for every thread, in the thread's own worktree,
 * through the environment scheduler — a leased tier queues through the pool
 * exactly like any other consumer. Results are stored on the thread; a loom
 * only reaches `ready` when every thread's latest verification is green.
 */
export async function POST(request: Request, context: Context) {
  try {
    const [{ loomId }, body] = await Promise.all([context.params, requestObject(request)]);
    const tier = optionalString(body.tier, "tier") ?? "unit";
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const client = await engineClient();
    for (const thread of loom.threads) {
      const snapshot = await client.session(thread.sessionId).catch(() => null);
      const cwd = snapshot?.session.workspace?.path;
      if (!cwd) {
        thread.verification = { tier, ok: false, at: Date.now(), detail: "no worktree path on the session record" };
        continue;
      }
      const result = await runTier(cwd, tier);
      thread.verification = {
        tier,
        ok: result.ok,
        at: Date.now(),
        detail: result.error ?? result.run?.output?.slice(-300),
      };
    }
    return Response.json(saveLoom(loom));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
