// M4 — the frozen-lane read-only verify + the guarded auto-repair loop driver.
//
// frozenLaneVerify runs the integration verify against an IMMUTABLE snapshot:
//   - filesystem: a git worktree pinned at the root's baseSha (M3 vcs.ts),
//   - data:       an ephemeral DB clone (db-clone.ts injectable seam),
// then drives runIntegrationVerify (whose panel leg is behind the verifier's
// hard read-only tool wall) against that snapshot. It is READ-ONLY by
// construction and cannot mutate the deliverable.
//
// runAutoRepair wraps the verify in a bounded loop whose continuation is
// decided SOLELY by the pure guards in repair-guard.ts (never by an LLM
// verdict). Its only two exits are `converged` (the loom stays "ready" — the
// caller never promotes to "done") or `escalate(reason)` (a fail/flaky verdict
// the weave demotes ready→needs-review, carrying `reason` on loom.error). This
// is the moat: a converged loop lands READY, never DONE.
import type { Loom } from "./looms";
import type { PanelReport, ProjectManifest, ServersConfig } from "./schemas";
import type { GateResult } from "./gates";
import type { BudgetState } from "./budget";
import {
  addWorktree,
  defaultGitRunner,
  type GitRunner,
  removeWorktree,
  withWorktreeLock,
} from "./vcs";
import { type DbCloner, NullDbCloner } from "./db-clone";
import { type RepairCaps, type RepairRound, decideRepairContinuation } from "./repair-guard";
import { resolveServersConfig as defaultResolveServersConfig } from "./servers";
import { type Lane, type StartLaneOpts, laneTarget, startLane as defaultStartLane } from "./run-server";

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

// The shape runIntegrationVerify returns (executor.ts). Redeclared here (not
// imported) to avoid a verify-thread → executor import cycle; it is structurally
// compatible. failingIds/passingIds are the STABLE assertion-id sets the guards
// consume (added by runIntegrationVerify, which owns the assertions).
export type IvResult = {
  verification: string;
  gatesOk: boolean;
  panelReport?: PanelReport | null;
  gates?: GateResult[];
  failingIds?: string[];
  passingIds?: string[];
  // M10.1 — the demote reason on a fail-closed whole-verify verdict (a required
  // panel that obtained no evidence). Informational; the weave gate demotes on
  // `verification`, never on this field.
  error?: string;
};

// The verify producer, injectable so frozenLaneVerify stays free of any executor
// import. verifyCwd (the frozen worktree) and subGoalId (checkpoint scoping) are
// additive; default = today's ALL-slice-against-manifest.root behavior.
export type RunIntegrationVerifyFn = (
  loom: Loom,
  manifest: ProjectManifest,
  opts: {
    verifyCwd?: string;
    subGoalId?: string;
    url?: string;
    abort?: AbortController;
    emit?: (ev: { type: string } & Record<string, unknown>) => void;
    // passthroughs the production binding fills in (policy/accounts/gateRunner/run)
    [k: string]: unknown;
  },
) => Promise<IvResult | null>;

export type FrozenLaneDeps = {
  runIntegrationVerify: RunIntegrationVerifyFn;
  git?: GitRunner; // default defaultGitRunner
  dbCloner?: DbCloner; // default NullDbCloner (no clone; ambient env)
  templateDb?: string; // the DB to clone from (live only)
  baseEnv?: NodeJS.ProcessEnv; // lane base env
  laneOpts?: StartLaneOpts; // lane injectable seams (spawn/fetch/runCommand/findPort)
  appService?: string; // which lane service's URL is the verify target
  resolveServersConfig?: (root: string, acceptedRoot?: string) => ServersConfig; // seam (default fs-backed); acceptedRoot = the .telar tier anchor (M7)
  startLane?: (config: ServersConfig, root: string, opts?: StartLaneOpts) => Promise<Lane>; // seam
  subGoalId?: string; // checkpoint scope (undefined ⇒ ALL slice)
  // M10.1 — the git ref the frozen worktree forks from. Default undefined ⇒
  // loom.baseSha (byte-identical to pre-M10.1). The orchestrator whole-verify
  // sets this to loom.consolidationBranch (telar/<rootId>) so the read-only
  // verify runs over the COMPOSED WHOLE the children built, not the pre-work base.
  forkRef?: string;
  // verify passthroughs
  abort?: AbortController;
  emit?: (ev: { type: string } & Record<string, unknown>) => void;
  verifyOpts?: Record<string, unknown>; // policy/accounts/gateRunner/run for the producer
};

// Run the integration verify against a FROZEN snapshot. Read-only by
// construction: the worktree is detached at a pinned SHA the repair agent can
// never touch, the panel runs under the verifier's hard tool wall, and the DB
// is an ephemeral clone dropped in the finally. When no baseSha is pinned
// (non-git root / neither isolation nor auto-repair pinned one), it degrades to
// verifying against manifest.root — still read-only, no snapshot.
export async function frozenLaneVerify(
  loom: Loom,
  manifest: ProjectManifest,
  deps: FrozenLaneDeps,
): Promise<IvResult | null> {
  const git = deps.git ?? defaultGitRunner;
  const cloner = deps.dbCloner ?? new NullDbCloner();
  const resolveCfg = deps.resolveServersConfig ?? defaultResolveServersConfig;
  const startLaneFn = deps.startLane ?? defaultStartLane;
  const passthrough = {
    subGoalId: deps.subGoalId,
    abort: deps.abort,
    emit: deps.emit,
    ...(deps.verifyOpts ?? {}),
  };

  // M10.1 — the fork ref: default loom.baseSha (byte-identical), or the ref the
  // whole-verify passes (consolidationBranch, falling back to baseSha at the
  // call site). A branch NAME is a valid ref — `git worktree add --detach <ref>`
  // detaches at the branch tip.
  const ref = deps.forkRef ?? loom.baseSha;

  if (!ref) {
    // No pinned snapshot — verify against the shared root (still read-only).
    return deps.runIntegrationVerify(loom, manifest, { ...passthrough });
  }

  const wt = await withWorktreeLock(() => addWorktree(git, manifest.root, ref, `frozen-${loom.id}`));
  let ephemeralDb = "";
  let lane: Lane | null = null;
  try {
    ephemeralDb = await cloner.clone(deps.templateDb ?? "", loom.id); // "" from NullDbCloner
    // M7 (D4): resolve against the frozen worktree `wt` for a repo-tracked
    // servers.yaml, BUT anchor the human-accepted `.telar/servers.yaml` tier at
    // manifest.root — `.telar/` is gitignored, so it is absent inside a fresh
    // frozen worktree. This lets an accepted env config survive re-verification.
    const cfg = resolveCfg(wt, manifest.root);
    if (cfg.driver !== "none") {
      const base = deps.baseEnv ?? process.env;
      const env = ephemeralDb ? { ...base, DATABASE_URL: ephemeralDb } : deps.baseEnv;
      lane = await startLaneFn(cfg, wt, { ...deps.laneOpts, ...(env ? { env } : {}) });
    }
    const target = lane ? laneTarget(lane, deps.appService) : manifest.urls?.dev;
    return await deps.runIntegrationVerify(loom, manifest, {
      ...passthrough,
      verifyCwd: wt,
      ...(target ? { url: target } : {}),
    });
  } finally {
    if (lane) await lane.stopAll().catch(() => {});
    if (ephemeralDb) await cloner.drop(ephemeralDb).catch(() => {});
    await withWorktreeLock(() => removeWorktree(git, manifest.root, wt)).catch(() => {});
  }
}

// --- the bounded auto-repair loop -------------------------------------------

// Build a RepairRound from a verify result. Prefers the STABLE id sets the
// producer computed; falls back to deriving them from the deterministic gates
// (GateResult.name === assertion id). The panel (lens-based) contributes no
// per-assertion ids, so the producer attributes the agent-judged slice as a set.
export function roundFromVerify(iv: IvResult, n: number, costUsd: number, ts: number): RepairRound {
  let failing = iv.failingIds;
  let passing = iv.passingIds;
  if (!failing || !passing) {
    const f: string[] = [];
    const p: string[] = [];
    for (const g of iv.gates ?? []) (g.ok ? p : f).push(g.name);
    failing = failing ?? f;
    passing = passing ?? p;
  }
  return {
    n,
    failingIds: uniqSorted(failing),
    passingIds: uniqSorted(passing),
    verification: iv.verification,
    costUsd,
    startedAt: ts,
    endedAt: ts,
  };
}

// The LLM repair leg — injectable. Authors a fix from the brief (into its OWN
// worktree, never the frozen snapshot) and reports its spend. Tests inject a
// spy; production wires a bounded repair agent.
export type RepairThreadFn = (loom: Loom, brief: string) => Promise<{ costUsd: number }>;

export type AutoRepairDeps = {
  // Re-verify against a FRESH frozen snapshot each round.
  verify: (loom: Loom) => Promise<IvResult | null>;
  repair: RepairThreadFn;
  budget: () => BudgetState; // read fresh each round (spentUsd grows)
  caps: RepairCaps;
  now?: () => number; // injected clock — the guards stay pure
  buildBrief?: (loom: Loom, iv: IvResult) => string;
  emit?: (ev: { type: string } & Record<string, unknown>) => void;
  onRound?: (round: RepairRound) => void; // persist hook (weave saves the loom)
};

// Drive the guarded auto-repair loop. Returns the FINAL verify result:
//   - converged ⇒ a pass/skip result (the caller keeps the loom "ready"),
//   - escalate  ⇒ the last fail/flaky result WITH loom.error set to the guard
//                 reason (the caller demotes ready→needs-review),
//   - null      ⇒ no ALL contract (no-op, identical to the plain producer).
// The loop NEVER promotes to "done" and NEVER spins: every exit is one of the
// two above, decided by decideRepairContinuation (pure). Records each round on
// loom.repairHistory.
export async function runAutoRepair(loom: Loom, deps: AutoRepairDeps): Promise<IvResult | null> {
  const now = deps.now ?? (() => Date.now());
  const emit = deps.emit ?? (() => {});

  const iv0 = await deps.verify(loom);
  if (!iv0) return null; // no ALL contract → byte-compatible with the plain producer (no repairHistory written)

  const history: RepairRound[] = (loom.repairHistory ??= []);

  let lastIv = iv0;
  const record = (iv: IvResult, costUsd: number) => {
    const round = roundFromVerify(iv, history.length + 1, costUsd, now());
    history.push(round);
    deps.onRound?.(round);
    emit({
      type: "repair-round",
      n: round.n,
      verification: round.verification,
      failing: round.failingIds,
      passing: round.passingIds,
      costUsd: round.costUsd,
    });
    return round;
  };
  record(iv0, 0);

  while (true) {
    const decision = decideRepairContinuation(history, deps.budget(), now(), deps.caps);
    if (decision.action === "converged") {
      emit({ type: "repair-decision", action: "converged" });
      return lastIv; // pass/skip → loom stays "ready" (moat: never "done")
    }
    if (decision.action === "escalate") {
      loom.error = decision.reason;
      emit({ type: "repair-decision", action: "escalate", reason: decision.reason });
      return lastIv; // fail/flaky → weave demotes ready→needs-review with loom.error
    }
    // action === "repair": dispatch one bounded repair, then re-verify.
    emit({ type: "repair-decision", action: "repair" });
    const brief = deps.buildBrief?.(loom, lastIv) ?? "";
    const { costUsd } = await deps.repair(loom, brief);
    const iv = await deps.verify(loom);
    if (!iv) {
      // Contract vanished mid-loop (should never happen) — stop, do not spin.
      loom.error = "integration contract disappeared during repair";
      return lastIv;
    }
    lastIv = iv;
    record(iv, costUsd);
  }
}
