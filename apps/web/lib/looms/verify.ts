import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineClient } from "@telar/engine-client";
import { appendEvent, saveLoom, type Loom } from "./store";

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
 * Each spawned thread's tier runs against a scratch checkout of the thread's
 * BRANCH, never the agent's own worktree: uncommitted work does not exist,
 * and the worker cannot doctor the checkout that grades it. Factored into
 * the lib so the verify route and the conductor run the IDENTICAL gate —
 * a conductor with a softer verify than the button would be a moat leak.
 */
export async function runLoomVerification(loom: Loom, client: EngineClient): Promise<Loom> {
  const { projects } = await client.listProjects();
  const projectRoot = projects.find((p) => p.id === loom.projectId)?.root;
  if (!projectRoot) throw new Error(`no project ${loom.projectId}`);

  for (const thread of loom.threads) {
    if (!thread.sessionId) continue;
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
    appendEvent(loom.id, {
      actor: "machine",
      kind: "verify",
      thread: thread.slug,
      ok: thread.verification.ok,
      commit,
      detail: `verified ${thread.slug}: ${tier} ${thread.verification.ok ? "green" : "red"} at ${commit.slice(0, 7)}`,
    });
  }
  return saveLoom(loom);
}
