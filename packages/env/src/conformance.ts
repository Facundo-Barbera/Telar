import { loadContract, loadMachinePolicy } from "./config.ts";
import { projectIdentity, worktreeRoot } from "./id.ts";
import { withState } from "./state.ts";
import { runVerb, waitReady, type VerbContext, type VerbResult } from "./verbs.ts";

export interface ConformanceStep {
  name: string;
  ok: boolean;
  detail: string;
  verb?: VerbResult;
}

export interface ConformanceReport {
  ok: boolean;
  projectId: string;
  worktree: string;
  slot: number;
  steps: ConformanceStep[];
}

/**
 * The acceptance sequence from env-contract-v1.md, run against a real slot:
 * up → ready, up again (idempotence), reset (if declared) → ready,
 * down → ready fails, down again exits 0.
 */
export async function runConformance(cwd: string): Promise<ConformanceReport> {
  const identity = projectIdentity(cwd);
  const worktree = worktreeRoot(cwd);
  const loaded = loadContract(identity.id, identity.root);
  const steps: ConformanceStep[] = [];
  const report = (slot: number): ConformanceReport => ({
    ok: steps.every((s) => s.ok),
    projectId: identity.id,
    worktree,
    slot,
    steps,
  });

  if (!loaded) {
    steps.push({ name: "contract", ok: false, detail: `no contract found for ${identity.id}` });
    return report(-1);
  }
  const { contract } = loaded;
  steps.push({ name: "contract", ok: true, detail: `${loaded.source}: ${loaded.path} (cost: ${contract.cost})` });
  if (contract.cost === "none") {
    steps.push({ name: "no-env", ok: true, detail: "cost is none — no environment verbs to conform" });
    return report(-1);
  }

  const policy = loadMachinePolicy();
  // Conformance runs on a scratch slot so it never disturbs a real lease.
  const { slot, portBase } = withState((state) => {
    const used = new Set(Object.values(state.slots[identity.id] ?? {}));
    let s = 1;
    while (used.has(s)) s++;
    const key = `${identity.id}/conform-${s}`;
    const base = state.ports[key] ?? policy.portRangeBase + state.nextPortOrdinal * policy.portRangeSize;
    if (!(key in state.ports)) {
      state.ports[key] = base;
      state.nextPortOrdinal += 1;
    }
    return { slot: s, portBase: base };
  });
  const ctx: VerbContext = { projectId: identity.id, worktree, slot, portBase };

  const step = (name: string, verb: VerbResult, okWhen: boolean, detail: string) => {
    steps.push({ name, ok: okWhen, detail, verb });
    return okWhen;
  };

  const up1 = await runVerb("up", contract.up!, ctx);
  if (!step("up", up1, up1.ok, `up exits ${up1.exitCode} in ${up1.durationMs}ms`)) return report(slot);

  const ready1 = await waitReady(contract.ready!, ctx);
  if (!step("ready", ready1, ready1.ok, ready1.ok ? "ready within timeout" : "ready never passed")) {
    await runVerb("down", contract.down!, ctx);
    return report(slot);
  }

  const up2 = await runVerb("up", contract.up!, ctx);
  step("up-idempotent", up2, up2.ok, up2.ok ? "second up is a no-op / fast reconcile" : "second up failed");

  if (contract.reset) {
    const reset = await runVerb("reset", contract.reset, ctx);
    if (reset.ok) {
      const readyAfter = await waitReady(contract.ready!, ctx, 60_000);
      step("reset", readyAfter, readyAfter.ok, readyAfter.ok ? "reset keeps the env ready" : "not ready after reset");
    } else {
      step("reset", reset, false, `reset exits ${reset.exitCode}`);
    }
  }

  const down1 = await runVerb("down", contract.down!, ctx);
  step("down", down1, down1.ok, `down exits ${down1.exitCode}`);

  const readyAfterDown = await runVerb("ready", contract.ready!, ctx);
  step("down-effective", readyAfterDown, !readyAfterDown.ok, readyAfterDown.ok ? "ready still passes after down" : "ready fails after down, as required");

  const down2 = await runVerb("down", contract.down!, ctx);
  step("down-idempotent", down2, down2.ok, down2.ok ? "down is safe on an already-down slot" : "second down failed");

  return report(slot);
}
