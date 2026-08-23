import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { engineClient, engineErrorResponse } from "@/lib/engine/engine-server";
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

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 60_000 });
    return { ok: true, out: stdout.trim() };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return { ok: false, out: (failure.stderr || failure.stdout || String(error)).trim() };
  }
}

/**
 * Verification at a CLEAN DESK (docs/loom-model-v1.md).
 *
 * Each thread's tier runs against a scratch checkout of the thread's BRANCH,
 * never the agent's own worktree. Two consequences, both the point:
 * uncommitted work does not exist, and the worker cannot doctor the checkout
 * that grades it. The tier itself goes through telar-env, so leasing rules
 * apply exactly as for any other consumer.
 */
export async function POST(_request: Request, context: Context) {
  try {
    const { loomId } = await context.params;
    const loom = getLoom(loomId);
    if (!loom) return Response.json({ error: { code: "not_found", message: `no loom ${loomId}` } }, { status: 404 });
    const client = await engineClient();
    const { projects } = await client.listProjects();
    const projectRoot = projects.find((p) => p.id === loom.projectId)?.root;
    if (!projectRoot) {
      return Response.json({ error: { code: "not_found", message: `no project ${loom.projectId}` } }, { status: 404 });
    }

    for (const thread of loom.threads) {
      const tier = thread.tier ?? "unit";
      const snapshot = await client.session(thread.sessionId).catch(() => null);
      const branch =
        thread.branch ?? (snapshot?.session.workspace?.mode === "worktree" ? snapshot.session.workspace.branch : undefined);
      if (!branch) {
        thread.verification = { tier, ok: false, at: Date.now(), detail: "no branch on the thread — nothing to verify" };
        continue;
      }
      const head = await git(projectRoot, ["rev-parse", branch]);
      if (!head.ok) {
        thread.verification = { tier, ok: false, at: Date.now(), detail: `branch ${branch} does not resolve: ${head.out.slice(0, 200)}` };
        continue;
      }
      const commit = head.out;
      const scratchParent = mkdtempSync(join(tmpdir(), "telar-verify-"));
      const scratch = join(scratchParent, "checkout");
      try {
        const added = await git(projectRoot, ["worktree", "add", "--detach", scratch, commit]);
        if (!added.ok) {
          thread.verification = { tier, ok: false, at: Date.now(), commit, detail: `scratch checkout failed: ${added.out.slice(0, 200)}` };
          continue;
        }
        const result = await runTier(scratch, tier);
        thread.verification = {
          tier,
          ok: result.ok,
          at: Date.now(),
          commit,
          detail: result.error ?? result.run?.output?.slice(-300),
        };
      } finally {
        await git(projectRoot, ["worktree", "remove", "--force", scratch]);
        await git(projectRoot, ["worktree", "prune"]);
        rmSync(scratchParent, { recursive: true, force: true });
      }
    }
    return Response.json(saveLoom(loom));
  } catch (error) {
    return engineErrorResponse(error);
  }
}
