import { loadContract } from "./config.ts";
import { projectIdentity, worktreeRoot } from "./id.ts";
import { acquire, release } from "./lease.ts";
import { snapshotState } from "./state.ts";
import { runVerb, type VerbContext, type VerbResult } from "./verbs.ts";

/**
 * Verification tiers: `unit` runs unleased (no environment), every other tier
 * runs inside a leased environment. This is what makes N parallel agents cheap
 * — the expensive tier queues through the pool, the cheap one never waits.
 */
export interface TierResult {
  tier: string;
  ok: boolean;
  /** Lease used for env-backed tiers; absent for unleased tiers. */
  leaseId?: string;
  /** True when the lease was kept for follow-up work instead of released. */
  leaseKept?: boolean;
  queuePosition?: number;
  error?: string;
  run?: VerbResult;
}

export interface RunTierOptions {
  cwd: string;
  tier: string;
  /**
   * Keep the lease after the tier finishes (e.g. a verifier that will drive
   * the environment next, or a repair loop). The caller owns releasing it.
   */
  keepLease?: boolean;
  readyTimeoutMs?: number;
}

const UNLEASED_TIERS = new Set(["unit"]);

export async function runTier(opts: RunTierOptions): Promise<TierResult> {
  const identity = projectIdentity(opts.cwd);
  const worktree = worktreeRoot(opts.cwd);
  const loaded = loadContract(identity.id, identity.root);
  if (!loaded) return { tier: opts.tier, ok: false, error: `no environment contract for ${identity.id}` };
  const command = loaded.contract.tiers?.[opts.tier];
  if (!command) {
    const declared = Object.keys(loaded.contract.tiers ?? {});
    return {
      tier: opts.tier,
      ok: false,
      error: `tier "${opts.tier}" is not declared${declared.length ? ` (declared: ${declared.join(", ")})` : ""}`,
    };
  }

  if (UNLEASED_TIERS.has(opts.tier) || loaded.contract.cost === "none") {
    // No environment: run in place. Slot/ports are informational if assigned.
    const slot = snapshotState().slots[identity.id]?.[worktree] ?? 0;
    const ctx: VerbContext = { projectId: identity.id, worktree, slot, portBase: 0 };
    const run = await runVerb("verify", command, ctx);
    return { tier: opts.tier, ok: run.ok, run };
  }

  const leased = await acquire({ cwd: opts.cwd, readyTimeoutMs: opts.readyTimeoutMs });
  if (!leased.granted || !leased.lease) {
    return {
      tier: opts.tier,
      ok: false,
      queuePosition: leased.queuePosition,
      error: leased.error ?? (leased.queuePosition ? `queued at position ${leased.queuePosition}` : "lease not granted"),
    };
  }
  const lease = leased.lease;
  const ctx: VerbContext = {
    projectId: lease.projectId,
    worktree: lease.worktree,
    slot: lease.slot,
    portBase: lease.portBase,
    leaseId: lease.id,
  };
  const run = await runVerb("verify", command, ctx);
  if (opts.keepLease) {
    return { tier: opts.tier, ok: run.ok, leaseId: lease.id, leaseKept: true, run };
  }
  await release(lease.id);
  return { tier: opts.tier, ok: run.ok, leaseId: lease.id, run };
}
