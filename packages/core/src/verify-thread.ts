// M4 — the frozen-lane read-only verify + the guarded auto-repair loop driver.
//
// frozenLaneVerify runs the integration verify against an IMMUTABLE snapshot:
//   - filesystem: a git worktree pinned at the root's baseSha (M3 vcs.ts),
//   - data:       an ephemeral DB clone (db-clone.ts injectable seam),
// then drives runIntegrationVerify (whose panel leg is behind the verifier's
// hard read-only tool wall) against that snapshot. It is READ-ONLY by
// construction and cannot mutate the deliverable.
//
// M11.2 (docs/adaptive-verification.md §3.3) — the lane is a STRATEGY SET, not
// only a URL: frozenLaneVerify chooses a VerificationStrategy
// (verification-strategy.ts) from the deliverable signal re-derived against the
// frozen worktree (artifact-time) + the contract shape. "server-lane" keeps
// today's resolveServersConfig → startLane → laneTarget path verbatim; a
// non-server strategy (test-gate / cli-harness / sandbox-eval / artifact-assert)
// stands NOTHING up — the frozen wt is the substrate, the producer's
// runContractGates settle the deterministic assertions there, and the panel
// gets NO target: the explicit `noTarget` marker withholds the producer's
// manifest.urls.dev fallback so any agent-judged leftover fail-closes via the
// M10.1 floor (never judged against a stale URL). A test-gate strategy also
// hands the producer its runnable as `establishRun` — the artifact-time
// ESTABLISHMENT: a sanctioned synthesized all-live-critic contract (greenfield
// prompt-fallback / charter gate intent / human verifyCommand) is tightened in
// memory to command gates that execute it, so the deferred-gate journey ends in
// real exit-code evidence instead of a guaranteed demote.
//
// runAutoRepair wraps the verify in a bounded loop whose continuation is
// decided SOLELY by the pure guards in repair-guard.ts (never by an LLM
// verdict). Its only two exits are `converged` (the loom stays "ready" — the
// caller never promotes to "done") or `escalate(reason)` (a fail/flaky verdict
// the weave demotes ready→needs-review, carrying `reason` on loom.error). This
// is the moat: a converged loop lands READY, never DONE.
import type { Loom } from "./looms";
import type { ContractAssertion, PanelReport, ProjectManifest, ServersConfig } from "./schemas";
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
import { type RepairCaps, type RepairRound, decideRepairContinuation, normalizeGateOutput } from "./repair-guard";
import { resolveServersConfig as defaultResolveServersConfig } from "./servers";
import { type Lane, type StartLaneOpts, laneTarget, startLane as defaultStartLane } from "./run-server";
import { readContract as defaultReadContract } from "./bundle";
import {
  type CharterProofIntent,
  type DeliverableSignal,
  deriveDeliverableSignal,
} from "./deliverable-signal";
import { type VerificationStrategy, chooseVerificationStrategy } from "./verification-strategy";

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
  // M10.3 — when set (injected by the dispatcher via frozenDeps),
  // convert a lane BRING-UP failure (startLane throws, resolveServersConfig
  // throws on a malformed servers.yaml) into a FAIL-CLOSED return: leave
  // lane=null, drive runIntegrationVerify with NO url (target=undefined), so the
  // panel's `if(!target)` divert skips and M10.1 demotes ready→needs-review.
  // CRITICAL: without this the bring-up throw propagates out of frozenLaneVerify
  // into weave.ts's fail-OPEN catch (keep-ready) — laundering a lane-down into a
  // false green. Absent/flag-off ⇒ the throw propagates as today (byte-identical).
  failClosedLaneDown?: boolean;
  // M11.2 (adaptive-verification.md §3.3) — strategy-layer seams. The layer is
  // consulted ONLY when failClosedLaneDown is set (the dispatcher's runtime
  // lane-down injection): otherwise neither seam is ever read.
  // Deliberately gated on the SAME condition that fail-closes
  // bring-up, so a strategy-selection throw can never escape into weave's
  // fail-open catch — it becomes laneDown → target=undefined → panel skip →
  // M10.1 demote.
  //   deriveSignal    — default deriveDeliverableSignal (pure fs read); called
  //                     against the frozen worktree `wt` — the ARTIFACT-TIME
  //                     re-derivation a deferred-gate plan promised.
  //   readContractFn  — default bundle readContract; the chooser needs the
  //                     contract SHAPE (deterministic vs agent-judged) to pick
  //                     artifact-assert / keep a live slice on today's path.
  //   chooseStrategy  — default chooseVerificationStrategy (pure); injectable
  //                     so tests can script a strategy directly.
  deriveSignal?: (root: string, charter?: CharterProofIntent) => DeliverableSignal;
  readContractFn?: (id: string) => { contract: { assertions: ContractAssertion[] } | null };
  chooseStrategy?: typeof chooseVerificationStrategy;
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
    // M10.3 — the lane BRING-UP. Flag-off (failClosedLaneDown absent) the catch
    // rethrows, so this is byte-identical to today (a throw propagates to weave's
    // fail-open catch). Flag-on, a bring-up failure is caught, emits a lane-down
    // event, leaves lane=null, and makes the target fail-closed (undefined) so
    // the panel skips and M10.1 demotes — never a throw into weave's fail-open.
    //
    // M11.2 (adaptive-verification.md §3.3) — the bring-up generalizes to a
    // VERIFICATION STRATEGY, established HERE, when the artifact exists, inside
    // the frozen worktree. Default "server-lane" = today's path verbatim; the
    // chooser runs ONLY under failClosedLaneDown, inside the
    // same guarded try, so a selection failure fail-closes exactly like a
    // bring-up failure. A NON-server strategy calls NO startLane: the frozen
    // `wt` is already the substrate — the producer below (runIntegrationVerify,
    // verifyCwd: wt) settles the deterministic assertions via runContractGates
    // against it, yielding GateResult[] evidence with no URL.
    let laneDown = false;
    let strategy: VerificationStrategy = {
      kind: "server-lane",
      reason: "strategy not yet chosen (default server-lane)",
    };
    try {
      const cfg = resolveCfg(wt, manifest.root);
      if (deps.failClosedLaneDown) {
        const signal = (deps.deriveSignal ?? deriveDeliverableSignal)(wt, loom.charter);
        const { contract } = (deps.readContractFn ?? defaultReadContract)(loom.id);
        strategy = (deps.chooseStrategy ?? chooseVerificationStrategy)(signal, contract?.assertions ?? [], {
          serverConfigured: cfg.driver !== "none",
          // The human-answered strategy answer (answerBlocked → telar.yaml):
          // chooser rule 3 — outranks the derived signal, supplies the
          // establishment runnable even for a signal-less repo.
          verifyCommand: manifest.verifyCommand,
        });
        // Observability only (a loom event, never a verdict input). Emitted only
        // for a NON-server pick so the server path's event stream stays exactly
        // today's.
        if (strategy.kind !== "server-lane") {
          deps.emit?.({ type: "verify-strategy", strategy: strategy.kind, reason: strategy.reason });
        }
      }
      // Only the server lane stands processes up. The chooser routes every
      // process-standing case (web, API/DB boot+hit, a DS kernel declared as a
      // service) to "server-lane" — under the dispatcher's injection
      // startLaneFn IS superviseStartLane, so those processes live behind the
      // executor/setup wall (verify-lane.ts). Defense-in-depth: a non-server
      // strategy skips bring-up even if a config resolves.
      if (strategy.kind === "server-lane" && cfg.driver !== "none") {
        const base = deps.baseEnv ?? process.env;
        const env = ephemeralDb ? { ...base, DATABASE_URL: ephemeralDb } : deps.baseEnv;
        lane = await startLaneFn(cfg, wt, { ...deps.laneOpts, ...(env ? { env } : {}) });
      }
    } catch (err) {
      if (!deps.failClosedLaneDown) throw err; // flag-off: propagate (weave fail-open), byte-identical
      laneDown = true;
      lane = null;
      deps.emit?.({ type: "verify-lane-down", message: err instanceof Error ? err.message : String(err) });
    }
    // Fail-closed: a downed lane or a NON-server strategy yields NO target —
    // never a fall-back to manifest.urls.dev. Merely omitting `url` is NOT
    // enough: the producer's own `opts.url ?? manifest.urls?.dev` fallback
    // would silently reinstate the stale URL and the live-critic panel would
    // be judged against it (a false green through the method layer). So the
    // decision is threaded EXPLICITLY as `noTarget`, which the producer honors
    // by withholding its fallback → the panel hits the no-target floor
    // (executor.ts runPanelVerification, panelRequired:true) and the M10.1
    // coercion demotes. A library is never "judged" against a stale
    // manifest.urls.dev. Both conditions are reachable ONLY under
    // failClosedLaneDown (flag-off: laneDown stays false, strategy stays
    // "server-lane", no marker is sent — byte-identical).
    const noTarget = laneDown || strategy.kind !== "server-lane";
    const target = noTarget ? undefined : lane ? laneTarget(lane, deps.appService) : manifest.urls?.dev;
    // M11.2 — the ESTABLISHMENT hand-off (the deferred-gate promise): a
    // test-gate strategy carries the runnable the wt re-derivation (or the
    // human's verifyCommand) answered; the producer executes it as a gate —
    // but only under its own sanction check (synthesized all-live-critic +
    // declared gate intent / prompt fallback / human answer), so this can only
    // TIGHTEN live-critic → command, never rubber-stamp authored prose.
    const establishRun = !laneDown && strategy.kind === "test-gate" && strategy.run?.trim() ? strategy.run.trim() : undefined;
    return await deps.runIntegrationVerify(loom, manifest, {
      ...passthrough,
      verifyCwd: wt,
      ...(target ? { url: target } : {}),
      ...(noTarget ? { noTarget: true } : {}),
      ...(establishRun ? { establishRun } : {}),
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
  // M11.4 (finding 4) — attach a per-failing-id output signature from the
  // DETERMINISTIC gates so the pure signature guard can detect a gate that fails
  // byte-identically across rounds. Only the failing gates contribute
  // (GateResult.name === assertion id); a panel-attributed failing id with no
  // gate simply has no signature (the guard treats it as non-stuck — safe). Left
  // undefined when no gate signatures exist so a panel-only/legacy round stays
  // byte-identical to pre-M11.
  const failingSig: Record<string, string> = {};
  for (const g of iv.gates ?? []) {
    if (!g.ok) failingSig[g.name] = normalizeGateOutput(g.output);
  }
  return {
    n,
    failingIds: uniqSorted(failing),
    passingIds: uniqSorted(passing),
    verification: iv.verification,
    costUsd,
    startedAt: ts,
    endedAt: ts,
    ...(Object.keys(failingSig).length > 0 ? { failingSig } : {}),
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
// An EVIDENCE-GAP fail: the whole-verify verdict is "fail" but NO evidence a
// builder can act on was produced — every deterministic gate is GREEN (gatesOk)
// and the required panel produced NO report (it could not run: no reachable
// live target / no critic agent). This is the M10.1 fail-closed coercion of a
// required-but-unrun panel to "fail", NOT a falsified check. Repairing code
// cannot close it (the next re-verify hits the same no-target wall), so the
// auto-repair loop must escalate rather than spend futile rounds. A red gate
// (gatesOk false) or a panel that RAN and failed (panelReport present) is a
// genuine, repairable signal and is explicitly excluded. Pure.
function isEvidenceGapFail(iv: IvResult): boolean {
  if (iv.verification !== "fail" && iv.verification !== "flaky") return false;
  if (!iv.gatesOk) return false; // a red deterministic gate IS a repairable signal
  if (iv.panelReport) return false; // a panel that ran and failed IS a repairable signal
  return true;
}

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
    // action === "repair": dispatch one bounded repair, then re-verify — BUT
    // only when the fail carries a signal a builder can act on. An EVIDENCE-GAP
    // fail (verification "fail" with every deterministic gate GREEN — gatesOk —
    // and NO panel report) is a required panel that obtained NO evidence: no
    // reachable live target / no critic could run, so the whole-verify coerced a
    // required-but-unrun panel to "fail" fail-closed (executor.ts M10.1). A code
    // repair cannot conjure a live target or critic, and the next re-verify would
    // hit the identical no-evidence wall — the loop would dispatch a futile,
    // EMPTY-brief repair every round until the iteration cap, never demoting. The
    // deterministic-gate guards (repair-guard.ts) can't see this: they reason over
    // failing-id SETS/signatures, and an agent-judged id carries no gate signature.
    // So escalate HERE, fail-closed: return the fail so the weave settles the root
    // `needs-review` (never `done`), the honest terminal for an unprovable whole.
    // A RED gate (gatesOk false) or a panel that RAN and failed (panelReport set)
    // both carry a real repair signal and take the normal repair path below.
    if (isEvidenceGapFail(lastIv)) {
      loom.error = lastIv.error ?? "verification produced no repairable evidence (required panel did not run)";
      emit({ type: "repair-decision", action: "escalate", reason: loom.error });
      return lastIv;
    }
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
