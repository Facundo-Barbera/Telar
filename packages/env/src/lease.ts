import { randomUUID } from "node:crypto";
import { loadContract, loadMachinePolicy, type CostClass, type EnvContract, type MachinePolicy } from "./config.ts";
import { recordEvent } from "./events.ts";
import { projectIdentity, worktreeRoot } from "./id.ts";
import { pidAlive, withState, type EnvState, type Lease, type WarmEnv } from "./state.ts";
import { runVerb, waitReady, type VerbContext, type VerbResult } from "./verbs.ts";

export interface AcquireResult {
  granted: boolean;
  /** Present when granted and the contract needs an environment (cost != none). */
  lease?: Lease;
  /** True when this call returned an already-held lease (the repair exception). */
  existing?: boolean;
  /** True when a kept-warm environment was reused, skipping `up`. */
  reusedWarm?: boolean;
  cost: EnvContract["cost"];
  queuePosition?: number;
  error?: string;
  verbs?: VerbResult[];
}

/** The minimal shape teardown needs; leases and warm envs both satisfy it. */
interface EnvRef {
  projectId: string;
  worktree: string;
  slot: number;
  portBase: number;
  leaseId?: string;
}

function ensureSlot(state: EnvState, projectId: string, worktree: string, primaryRoot: string): number {
  const slots = (state.slots[projectId] ??= {});
  if (worktree in slots) return slots[worktree]!;
  if (worktree === primaryRoot) return (slots[worktree] = 0);
  const used = new Set(Object.values(slots));
  let slot = 1;
  while (used.has(slot)) slot++;
  return (slots[worktree] = slot);
}

function ensurePortBase(state: EnvState, policy: MachinePolicy, projectId: string, slot: number): number {
  const key = `${projectId}/${slot}`;
  if (key in state.ports) return state.ports[key]!;
  const base = policy.portRangeBase + state.nextPortOrdinal * policy.portRangeSize;
  state.nextPortOrdinal += 1;
  return (state.ports[key] = base);
}

function warmKey(projectId: string, worktree: string): string {
  return `${projectId}/${worktree}`;
}

/** Active + warm environments both occupy pool capacity — warm still holds RAM. */
function occupancy(state: EnvState, cost: CostClass, projectId: string): number {
  const leases = Object.values(state.leases).filter((l) => l.cost === cost);
  const warm = Object.values(state.warm).filter((w) => w.cost === cost);
  if (cost === "heavy") return leases.length + warm.length; // machine-global
  return (
    leases.filter((l) => l.projectId === projectId).length +
    warm.filter((w) => w.projectId === projectId).length
  );
}

export interface ReclaimedEnvs {
  staleLeases: Lease[];
  expiredWarm: WarmEnv[];
}

/**
 * Remove leases whose holder died or whose TTL expired, and warm environments
 * older than the TTL. Returns them so callers run `down` outside the state
 * lock — reclaim happens between verb invocations, never mid-verify.
 */
export function reclaimStale(): ReclaimedEnvs {
  const now = Date.now();
  const ttlMs = loadMachinePolicy().leaseTtlMinutes * 60_000;
  return withState((state) => {
    const staleLeases = Object.values(state.leases).filter((l) => !pidAlive(l.pid) || l.expiresAt < now);
    for (const l of staleLeases) {
      delete state.leases[l.id];
      recordEvent("lease.reclaimed", { leaseId: l.id, projectId: l.projectId, worktree: l.worktree });
    }
    const expiredWarm = Object.entries(state.warm)
      .filter(([, w]) => now - w.since > ttlMs)
      .map(([key, w]) => {
        delete state.warm[key];
        recordEvent("env.warm-expired", { projectId: w.projectId, worktree: w.worktree, slot: w.slot });
        return w;
      });
    return { staleLeases, expiredWarm };
  });
}

async function runDownFor(env: EnvRef): Promise<VerbResult | null> {
  const loaded = loadContract(env.projectId, env.worktree);
  if (!loaded?.contract.down) return null;
  const ctx: VerbContext = {
    projectId: env.projectId,
    worktree: env.worktree,
    slot: env.slot,
    portBase: env.portBase,
    leaseId: env.leaseId,
  };
  return runVerb("down", loaded.contract.down, ctx);
}

/** Best-effort teardown of reclaimed leases and expired warm environments. */
export async function downStale(reclaimed: ReclaimedEnvs): Promise<VerbResult[]> {
  const results: VerbResult[] = [];
  for (const lease of reclaimed.staleLeases) {
    const r = await runDownFor({ ...lease, leaseId: lease.id });
    if (r) results.push(r);
  }
  for (const warm of reclaimed.expiredWarm) {
    const r = await runDownFor(warm);
    if (r) results.push(r);
  }
  return results;
}

export interface AcquireOptions {
  cwd: string;
  /** Ready-poll budget; defaults to 180s. */
  readyTimeoutMs?: number;
}

interface Decision {
  lease?: Lease;
  existing?: boolean;
  fromWarm?: boolean;
  queuePosition?: number;
  /** Warm envs evicted to make room; torn down outside the lock. */
  evicted: WarmEnv[];
}

export async function acquire(opts: AcquireOptions): Promise<AcquireResult> {
  const identity = projectIdentity(opts.cwd);
  const worktree = worktreeRoot(opts.cwd);
  const loaded = loadContract(identity.id, identity.root);
  if (!loaded) {
    return {
      granted: false,
      cost: "none",
      error: `no environment contract for ${identity.id} — expected a sidecar env.yaml or a telar.yaml env block`,
    };
  }
  const { contract } = loaded;
  if (contract.cost === "none") return { granted: true, cost: "none" };

  const policy = loadMachinePolicy();
  await downStale(reclaimStale());

  const ttlMs = policy.leaseTtlMinutes * 60_000;
  const cap = contract.cost === "heavy" ? policy.pool.heavy : policy.pool.light;

  const decision = withState((state): Decision => {
    const evicted: WarmEnv[] = [];
    const held = Object.values(state.leases).find(
      (l) => l.worktree === worktree && l.projectId === identity.id,
    );
    if (held) {
      // Repair exception: verify → repair keeps the same lease; renew it.
      held.expiresAt = Date.now() + ttlMs;
      return { lease: held, existing: true, evicted };
    }

    const mint = (slot: number, portBase: number): Lease => {
      const lease: Lease = {
        id: randomUUID(),
        projectId: identity.id,
        worktree,
        slot,
        portBase,
        cost: contract.cost,
        pid: process.pid,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      state.leases[lease.id] = lease;
      return lease;
    };

    // A warm environment for this very worktree: reuse it, skip `up`.
    const key = warmKey(identity.id, worktree);
    const warm = state.warm[key];
    if (warm) {
      delete state.warm[key];
      const queueIndex = state.queue.findIndex((q) => q.worktree === worktree);
      if (queueIndex >= 0) state.queue.splice(queueIndex, 1);
      return { lease: mint(warm.slot, warm.portBase), fromWarm: true, evicted };
    }

    // Make room by evicting other worktrees' warm envs before queueing anyone.
    while (occupancy(state, contract.cost, identity.id) >= cap) {
      const evictable = Object.entries(state.warm).find(
        ([, w]) => w.cost === contract.cost && (contract.cost === "heavy" || w.projectId === identity.id),
      );
      if (!evictable) break;
      delete state.warm[evictable[0]];
      evicted.push(evictable[1]);
      recordEvent("env.warm-evicted", {
        projectId: evictable[1].projectId,
        worktree: evictable[1].worktree,
        for: worktree,
      });
    }

    const capacity = occupancy(state, contract.cost, identity.id) < cap;
    const queueIndex = state.queue.findIndex((q) => q.worktree === worktree);
    const isHead = queueIndex === 0 || state.queue.length === 0;
    if (!capacity || !isHead) {
      if (queueIndex === -1) {
        state.queue.push({ projectId: identity.id, worktree, requestedAt: Date.now() });
        recordEvent("lease.queued", { projectId: identity.id, worktree, position: state.queue.length });
        return { queuePosition: state.queue.length, evicted };
      }
      return { queuePosition: queueIndex + 1, evicted };
    }
    if (queueIndex === 0) state.queue.shift();

    const slot = ensureSlot(state, identity.id, worktree, identity.root);
    const portBase = ensurePortBase(state, policy, identity.id, slot);
    return { lease: mint(slot, portBase), evicted };
  });

  for (const warm of decision.evicted) await runDownFor(warm);

  if (!decision.lease) {
    return { granted: false, cost: contract.cost, queuePosition: decision.queuePosition };
  }
  if (decision.existing) {
    recordEvent("lease.renewed", { leaseId: decision.lease.id, worktree });
    return { granted: true, cost: contract.cost, lease: decision.lease, existing: true };
  }

  const lease = decision.lease;
  const ctx: VerbContext = {
    projectId: lease.projectId,
    worktree: lease.worktree,
    slot: lease.slot,
    portBase: lease.portBase,
    leaseId: lease.id,
  };
  const verbs: VerbResult[] = [];

  if (decision.fromWarm) {
    // Confirm the warm env is still alive; fall through to a full `up` if not.
    const stillReady = await runVerb("ready", contract.ready!, ctx);
    verbs.push(stillReady);
    if (stillReady.ok) {
      recordEvent("env.warm-reused", { leaseId: lease.id, worktree, slot: lease.slot });
      return { granted: true, cost: contract.cost, lease, reusedWarm: true, verbs };
    }
  }

  // Two-phase: the slot is reserved; bring the environment up outside the lock.
  const up = await runVerb("up", contract.up!, ctx);
  verbs.push(up);
  if (up.ok) {
    const ready = await waitReady(contract.ready!, ctx, opts.readyTimeoutMs ?? 180_000);
    verbs.push(ready);
    if (ready.ok) {
      recordEvent("lease.granted", { leaseId: lease.id, projectId: lease.projectId, worktree, slot: lease.slot });
      return { granted: true, cost: contract.cost, lease, verbs };
    }
  }

  // Roll back the reservation and tear down whatever half-started.
  if (contract.down) verbs.push(await runVerb("down", contract.down, ctx));
  withState((state) => {
    delete state.leases[lease.id];
  });
  const failed = verbs.find((v) => !v.ok);
  return {
    granted: false,
    cost: contract.cost,
    error: `${failed?.verb ?? "up"} failed (exit ${failed?.exitCode}): ${failed?.output.slice(-500) ?? ""}`,
    verbs,
  };
}

export interface ReleaseOptions {
  /** Force teardown even when the pool would keep the environment warm. */
  down?: boolean;
}

export interface ReleaseResult {
  released: boolean;
  /** True when the environment was left running for fast reacquisition. */
  keptWarm?: boolean;
  error?: string;
  down?: VerbResult | null;
}

export async function release(leaseId: string, opts: ReleaseOptions = {}): Promise<ReleaseResult> {
  const outcome = withState((state): { lease: Lease | null; keepWarm: boolean } => {
    const lease = state.leases[leaseId];
    if (!lease) return { lease: null, keepWarm: false };
    delete state.leases[leaseId];
    // Keep warm only when nobody is waiting — a queue means the RAM is spoken for.
    const keepWarm = !opts.down && state.queue.length === 0;
    if (keepWarm) {
      state.warm[warmKey(lease.projectId, lease.worktree)] = {
        projectId: lease.projectId,
        worktree: lease.worktree,
        slot: lease.slot,
        portBase: lease.portBase,
        cost: lease.cost,
        since: Date.now(),
      };
      recordEvent("env.kept-warm", { leaseId, worktree: lease.worktree, slot: lease.slot });
    }
    recordEvent("lease.released", { leaseId, worktree: lease.worktree, keptWarm: keepWarm });
    return { lease, keepWarm };
  });
  if (!outcome.lease) return { released: false, error: `no such lease: ${leaseId}` };
  if (outcome.keepWarm) return { released: true, keptWarm: true };
  const down = await runDownFor({ ...outcome.lease, leaseId: outcome.lease.id });
  if (down && !down.ok) {
    return { released: true, down, error: `released, but down failed (exit ${down.exitCode})` };
  }
  return { released: true, down };
}

export function renew(leaseId: string): { renewed: boolean; expiresAt?: number; error?: string } {
  const policy = loadMachinePolicy();
  return withState((state) => {
    const lease = state.leases[leaseId];
    if (!lease) return { renewed: false, error: `no such lease: ${leaseId}` };
    lease.expiresAt = Date.now() + policy.leaseTtlMinutes * 60_000;
    return { renewed: true, expiresAt: lease.expiresAt };
  });
}
