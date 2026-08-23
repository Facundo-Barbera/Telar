import { spawnSync } from "node:child_process";
import { loadContract, loadMachinePolicy } from "./config.ts";
import { projectIdentity, worktreeRoot } from "./id.ts";
import { snapshotState } from "./state.ts";

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  slot: number | null;
  isPrimary: boolean;
}

export function listWorktrees(cwd: string): WorktreeInfo[] {
  const identity = projectIdentity(cwd);
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return [];
  const state = snapshotState();
  const slots = state.slots[identity.id] ?? {};
  const out: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of `${r.stdout}\n`.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9) };
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "" && current.path) {
      out.push({
        path: current.path,
        branch: current.branch ?? null,
        slot: current.path in slots ? slots[current.path]! : current.path === identity.root ? 0 : null,
        isPrimary: current.path === identity.root,
      });
      current = {};
    }
  }
  return out;
}

export interface CreateWorktreeResult {
  ok: boolean;
  path?: string;
  branch?: string;
  error?: string;
}

export function createWorktree(cwd: string, branch: string, path?: string): CreateWorktreeResult {
  const identity = projectIdentity(cwd);
  const slugged = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const target = path ?? `${identity.root}-wt-${slugged}`;
  const r = spawnSync("git", ["worktree", "add", target, "-b", branch], {
    cwd: identity.root,
    encoding: "utf8",
  });
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  return { ok: true, path: target, branch };
}

/** Everything Telar knows about the project at cwd — the briefing for an agent session. */
export function projectContext(cwd: string) {
  const identity = projectIdentity(cwd);
  const loaded = loadContract(identity.id, identity.root);
  const state = snapshotState();
  const leases = Object.values(state.leases).filter((l) => l.projectId === identity.id);
  return {
    project: identity,
    currentWorktree: worktreeRoot(cwd),
    contract: loaded ? { source: loaded.source, path: loaded.path, env: loaded.contract } : null,
    policy: loadMachinePolicy(),
    worktrees: listWorktrees(cwd),
    activeLeases: leases,
    queue: state.queue.filter((q) => q.projectId === identity.id),
  };
}
