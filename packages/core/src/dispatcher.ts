// Dispatcher: fire-and-forget seam between request handlers and the executor.
// Persistence is wired here (looms.ts); abort handles live only in this
// process's memory — cancel works while the loom's process is alive.
import fs from "node:fs";
import path from "node:path";
import {
  ModelPolicy,
  Roster,
  assertProvenance,
  isWoven,
  isSingleThreadWeave,
  type AccountProfile,
  type Charter,
  type ProjectManifest,
  type ProofStrategy,
  type Provenance,
  type ServersConfig,
  type SubGoal,
} from "./schemas";
import { agent } from "./engine";
import {
  buildFanoutEnabled,
  decideBuildFanout,
  piecesAreDisjoint,
  splitBuild as splitBuildDefault,
  type BuildPiece,
} from "./build-fanout";
import { getProject, listProjects, telarDir, writeManifest } from "./manifest";
import { createLoom, saveLoom, appendEvent, getLoom, listLooms, listChildLooms, loomDir, type Loom, type LoomKind } from "./looms";
import { buildIntegrationRepairBrief, executeLoom, isLaneViable, partitionAssertions, runIntegrationVerify, runRepairThread, type ExecuteOpts } from "./executor";
import {
  autoRepairEnabled,
  createConsolidationBranch,
  defaultGitRunner,
  isolationEnabled,
  reapOrphanWorktrees,
  resolveBaseSha,
} from "./vcs";
import { resolveDbCloner } from "./db-clone";
import { EST_COST_PER_AGENT } from "./tick";
import { type BudgetState, DEFAULT_MAX_AGENTS } from "./budget";
import { frozenLaneVerify, type IvResult, runAutoRepair } from "./verify-thread";
import { finalizeConsolidation } from "./consolidate";
import { runWeave } from "./weave";
import { draftCharter as draftCharterDefault, needsScoping, planWeaveFromBundle, validateCharter } from "./scoping";
import { appendSteering, readBundleFile, readContract, snapshotBundle, writeContract, writeProvenance } from "./bundle";
import { synthesizeContract, wireChildBundle } from "./weave-contracts";
import { reconcileState, type RecoverAction } from "./runner/recover";
import { makeInProcessLiveness, type Liveness } from "./runner/liveness";
import { envReviewEnabled, laneEscalationEnabled, orchestratorVerifyEnabled, setupAgentEnabled, verifyLaneEnabled } from "./runner/flag";
import { runSetupAgent } from "./setup/setup-agent";
import { superviseStartLane } from "./verify-lane";
import type { Lane, StartLaneOpts } from "./run-server";
import { writeAcceptedServersConfig, writeAcceptedRunbook } from "./servers";
import type { ContractAssertion } from "./schemas";

export type StartLoomInput = {
  project: string;
  kind: LoomKind;
  title: string;
  prompt: string;
  acceptanceCriteria?: string[];
  maxAttempts?: number;
  target?: "dev" | "preview" | "prod";
  charter?: Charter;
  proofStrategy?: ProofStrategy;
};
export type DispatcherDeps = {
  accounts: Record<string, AccountProfile>;
  policy?: ModelPolicy;
  roster?: Roster;
  // Injectors — tests swap these for fakes so no live agent/model runs.
  draftCharterFn?: typeof draftCharterDefault;
  planWeaveFn?: typeof planWeaveFromBundle;
  runLoomFn?: (loom: Loom, manifest: ProjectManifest, opts: ExecuteOpts) => Promise<Loom>;
  // M6 — the read-only build-splitter planner (build-fanout.ts). Injected so a
  // fan-out wiring test drives the dispatch→executor seam with canned pieces
  // and no live model.
  splitBuildFn?: typeof splitBuildDefault;
};

const active = new Map<string, AbortController>();

// Persistence guard shared by every fire-and-forget background chain below —
// executeLoom/runWeave/draftCharter contractually never reject, but a throw
// here (e.g. a full disk) must never surface as an unhandled rejection and
// crash the server. Each write is attempted independently.
function makeOnFailure(loom: Loom): (err: unknown) => void {
  return (err: unknown) => {
    loom.state = "failed";
    loom.error = err instanceof Error ? err.message : String(err);
    try {
      appendEvent(loom.id, { type: "error", message: loom.error });
    } catch {}
    try {
      saveLoom(loom);
    } catch {}
  };
}

// M10.4 (laneEscalation) — the ONLY place in packages/core/src that SETS
// state:"blocked", making the dead enum reachable. Mirrors
// proposeEnvOrNeedsReview's PARK shape: stash a machine-facing blockedReason + a
// human-facing narrative blockedQuestion (the analog of proposedServers), flip
// state to "blocked", append the escalation + state events, and save. Writes
// NOTHING to `.telar` or the manifest — persistence happens ONLY post-human-accept
// inside answerBlocked, strictly after its non-blank `by` guard. `blocked` is an
// awaiting-human PARK (recover.ts → "leave"), in NEITHER TERMINAL_STATES nor
// IN_FLIGHT_STATES — never an autonomous promotion, never a strand: dispatch
// RETURNS to the caller with a paused, resumable loom.
function parkBlockedIfLaneUnviable(loom: Loom, assertions: ContractAssertion[]): void {
  const { agentJudged } = partitionAssertions(assertions);
  loom.blockedReason =
    `The verification lane is not viable: ${agentJudged.length} agent-judged assertion(s) ` +
    `need a live target, but the project has no devCommand, no servers.yaml/.telar tier, ` +
    `and the setup agent is off — nothing can bring the app up to drive verification.`;
  loom.blockedQuestion =
    "How do I run this app so verification can drive it? Give me a dev command " +
    "(e.g. `bun run dev`) or a servers recipe, plus any steps to reach the feature.";
  loom.state = "blocked";
  appendEvent(loom.id, { type: "lane-escalation", by: "telar" });
  appendEvent(loom.id, { type: "state", state: "blocked" });
  saveLoom(loom);
}

// Fork C — a plain custom loom becomes a WEAVE OF ONE: a deterministic,
// single-subgoal decomposition (no planner LLM). The one SubGoal carries the
// loom's acceptanceCriteria (blocker #2) so wireChildBundle's legacy-verify
// fallback keeps verification alive past executor.ts:514, and is required:true
// so the moat's finish-loom gate (validateDecision / rollupWeave) is real.
export function singleThreadDecomposition(loom: Loom): SubGoal[] {
  return [
    {
      id: "s1",
      title: loom.title,
      detail: loom.prompt,                                   // -> child objective.md (weave-contracts.ts:37)
      proofStrategy: loom.charter?.proofStrategy ?? "custom", // -> child kind "custom" (dispatcher.ts:78)
      acceptanceCriteria: loom.acceptanceCriteria ?? [],      // CARRIED — blocker #2
      dependsOn: [],
      required: true,                                         // moat: finish-loom gates on this
      status: "pending",
    },
  ];
}

// Attach (first dispatch) or refresh (re-dispatch of a weave-of-one) the
// weave-of-one charter so isWoven(loom) is TRUE and runWeave has a decomposition
// to schedule. A plain custom loom with no charter gets a minimal VALID charter;
// a caller-supplied non-woven charter keeps its objective/scope/budget and just
// gains the single subgoal. Marked singleThread:true so the two epic-POLICY/
// LABEL sites can exclude it (blocker #4). A real (planner) epic is untouched.
function ensureWoven(loom: Loom): void {
  if (!isWoven(loom)) {
    const base = loom.charter;
    loom.charter = {
      objective: base?.objective ?? loom.title,
      proofStrategy: base?.proofStrategy ?? "custom",
      scope: base?.scope ?? { allowedPaths: [], forbiddenPaths: [] },
      budget: base?.budget ?? { maxParallelThreads: 1, maxAgents: 12, maxCriticAgents: 3 },
      decomposition: singleThreadDecomposition(loom),
      version: base?.version ?? 1,
      approvedBy: base?.approvedBy ?? "auto:single-thread",
      singleThread: true,
    };
    return;
  }
  // Re-dispatch of an EXISTING weave-of-one: regenerate the single subgoal so a
  // steer/reject directive (folded into loom.prompt by steer/reject) reaches the
  // reused child. Id stays "s1" so spawnChild's reuse-by-subGoalId still matches.
  if (isSingleThreadWeave(loom)) {
    loom.charter!.decomposition = singleThreadDecomposition(loom);
  }
}

// The weave branch: spawn+run child Looms (threads) for the charter's
// decomposition and fold up via runWeave. Reused by both the fast path
// (charter supplied up front) and the post-scoping dispatch (charter drafted
// then approved).
function runWeaveWiring(
  loom: Loom,
  manifest: ProjectManifest,
  deps: DispatcherDeps,
  abort: AbortController,
  opts: { maxAttempts?: number } = {},
): Promise<Loom> {
  // PRECONDITION: callers run ensureWoven (or supply a real woven charter)
  // before dispatch, so loom.charter is always present here.
  const decomposition = loom.charter!.decomposition;
  const policy = deps.policy ?? loadPolicy();
  const roster = deps.roster ?? loadRoster();

  // M6 — the single place a child thread's build MAY fan out into N
  // worktree-isolated builders. Gated on BOTH flags (fan-out rides on worktree
  // isolation — each piece needs its own tree). Returns the populated
  // buildFanout opt, or null to run the single builder. Every failure mode
  // (planner throw, <2 pieces, budget/pool clamp to <2, a defense-in-depth
  // disjointness miss) degrades to the single builder — a fan-out NEVER turns a
  // runnable thread into a crashed one, and NEVER changes WHO accepts (moat).
  const planBuildFanout = async (child: Loom): Promise<{ pieces: BuildPiece[]; baseRef: string } | null> => {
    // 1. READ-ONLY planner proposes disjoint pieces (already collapses to [] on
    //    <2 pieces or any overlap). deps.splitBuildFn is the test seam.
    const pieces = await (deps.splitBuildFn ?? splitBuildDefault)(
      { prompt: child.prompt, manifest },
      { agent, account: deps.accounts?.[manifest.account], model: policy.dev },
    );
    if (pieces.length < 2) return null; // no disjoint partition — honest single-builder fallback

    // 2. Size against the SAME shared pool + budget the weaver clamps against.
    //    inFlight is conservative: maxParallelThreads (the max threads that may
    //    be live) so we never over-commit the pool from inside a runChild that
    //    has no direct view of the scheduler's live count.
    const budget = loom.charter!.budget;
    const n = decideBuildFanout(pieces.length, {
      maxAgents: budget.maxAgents,
      inFlight: Math.max(1, budget.maxParallelThreads ?? 1),
      budgetLeftUsd: budget.maxCostUsd ?? Infinity,
      estCostPerAgent: EST_COST_PER_AGENT,
    });
    if (n < 2) return null; // pool/budget left room for at most one builder

    const chosen = pieces.slice(0, n);
    // 3. Defense-in-depth: re-assert disjointness before handing overlap toward
    //    runBuildFanout's hard throw. Should be impossible after splitBuild.
    if (!piecesAreDisjoint(chosen)) return null;
    // baseRef "HEAD": runBuildFanout's repoRoot is the child's own isolated
    // worktree (executor buildCwd) — pieces branch off THAT tree's HEAD.
    return { pieces: chosen, baseRef: "HEAD" };
  };

  // M4 — the budget the auto-repair guards read each round. spentUsd folds in
  // the repair rounds' recorded cost (repairHistory) so the budget guard trips
  // at real headroom; inFlight is 0 (the repair loop runs after the weave's
  // pool has drained). Only constructed when the master flag is on.
  const rootRepairBudget = (l: Loom): BudgetState => {
    const b = l.charter?.budget;
    const spentUsd = (l.repairHistory ?? []).reduce((s, r) => s + r.costUsd, 0);
    return {
      maxAgents: b?.maxAgents ?? DEFAULT_MAX_AGENTS,
      inFlight: 0,
      spentUsd,
      startedAtMs: l.createdAt,
      maxCostUsd: b?.maxCostUsd,
      maxWallClockHours: b?.maxWallClockHours,
    };
  };
  // Shared frozen-lane deps builder (a fresh pinned snapshot per verify).
  // M10.1: `extra` opts in the orchestrator whole-verify — forkRef re-points the
  // fork to the consolidation branch (top-level), fullContract widens the slice
  // (via verifyOpts, passed through to runIntegrationVerify). Both absent ⇒
  // byte-identical to today (fork baseSha, ALL slice).
  const frozenDeps = (
    eventSink: Loom,
    subGoalId?: string,
    extra?: { forkRef?: string; fullContract?: boolean },
  ) => ({
    runIntegrationVerify: (lm: Loom, mf: ProjectManifest, o: Record<string, unknown>) =>
      runIntegrationVerify(lm, mf, { policy, accounts: deps.accounts, ...o }),
    dbCloner: resolveDbCloner(),
    subGoalId,
    abort,
    emit: (ev: { type: string } & Record<string, unknown>) => appendEvent(eventSink.id, ev),
    ...(extra?.forkRef ? { forkRef: extra.forkRef } : {}),
    ...(extra?.fullContract ? { verifyOpts: { fullContract: true } } : {}),
    // M10.3 (verifyLane ON): inject the SUPERVISED startLane wrapper + fail-closed
    // lane-down, so frozenLaneVerify PROACTIVELY stands a repairable lane up for
    // the top-gate pass and a bring-up failure demotes (never launders into
    // weave's fail-open keep-ready). A later-key-wins spread mirroring the
    // orchestratorVerify override — flag-off the spread is `{}`, frozenLaneVerify
    // falls back to the one-shot defaultStartLane, and every path (fork ref,
    // verdict, teardown, byte layout) is identical to M10.1. The lane is stood up
    // / restarted / torn down by startLane/superviseLane/lane.stopAll — the
    // EXECUTOR/SETUP-wall capability; the read-only judge (verifier/critic) is
    // never handed any of these functions, only the resolved target URL.
    ...(verifyLaneEnabled(manifest)
      ? {
          startLane: (config: ServersConfig, root: string, o?: StartLaneOpts): Promise<Lane> =>
            superviseStartLane(config, root, o),
          laneOpts: { captureLogs: true } as StartLaneOpts,
          failClosedLaneDown: true,
        }
      : {}),
  });
  // The root's full Verification Contract — wireChildBundle filters it down to
  // each Thread's own subGoalId slice.
  //
  // M1 (D0.3, D1.3): the UNIVERSAL choke point every loom passes through. If
  // the root has NO contract (a plain custom loom, a non-bundle woven root),
  // SYNTHESIZE one from its prose acceptanceCriteria/prompt and PERSIST it to
  // the root contract.json — this is the M1 invariant that EVERY loom ends up
  // with a contract. Persisting (not just building in-memory) is what makes
  // runIntegrationVerify's readContract non-null → full re-verify actually
  // fires. Idempotent: an authored contract (readContract non-null) is never
  // overwritten, and a re-dispatch reads the persisted synthesized contract
  // back → never re-synthesized. The first-ever write is unrestricted (its
  // co-sign only triggers when a PRIOR contract exists on a started loom).
  let { contract } = readContract(loom.id);
  if (!contract) {
    contract = synthesizeContract(loom);
    writeContract(loom.id, contract);
  }
  const rootAssertions = contract.assertions;
  const rootSynthesized = contract.synthesized === true;

  // M10.4 (laneEscalation ON) — PRE-FLIGHT lane-viability gate. Runs HERE, after
  // the contract is resolved/synthesized+persisted and BEFORE any spend (the
  // baseSha pin, the consolidation-branch create, and the runWeave child spawn
  // all live below). If a live target is needed (the contract has agent-judged
  // assertions) but the lane is unviable (no devCommand, no servers.yaml/.telar
  // tier) AND cannot be auto-provisioned (setupAgent is off — the only auto-spin
  // path), PARK the loom in `blocked` with a narrative question and RETURN before
  // ANY child forks or branch is created — so an unviable lane never strands
  // threads. laneEscalationEnabled is the FIRST && operand, so flag-off adds ZERO
  // reads and ZERO branches beyond today and dispatch flows straight into the
  // baseSha/branch/runWeave path exactly as it does now (byte-identical). Bounded:
  // a single synchronous decision over already-resolved inputs (isLaneViable is a
  // pure read of the contract + manifest + one filesystem tier) — it cannot loop
  // and cannot spawn a thread that strands.
  if (
    laneEscalationEnabled(manifest) &&
    !isLaneViable(manifest, rootAssertions) &&
    !setupAgentEnabled(manifest)
  ) {
    parkBlockedIfLaneUnviable(loom, rootAssertions);
    return Promise.resolve(loom);
  }

  // M3: pin the base SHA + create the review branch at ROOT start, BEFORE any
  // child spawns — children read root.baseSha to fork their own worktrees
  // (executor.ts). A non-git root / branch-create failure degrades isolation to
  // the shared-root path (no worktree, no branch) rather than breaking dispatch.
  // Idempotent on re-dispatch: createConsolidationBranch leaves an existing
  // telar/<id> branch untouched. (Base-SHA pinning + branch setup live here —
  // not in weave.ts — because this is the seam that has the manifest + git
  // runner, mirroring how runIntegrationVerify is wired in as a dep below.)
  // M4: auto-repair ALSO needs the pinned base SHA (its frozen snapshot forks
  // from it), so pin when EITHER flag is on. The consolidation BRANCH is an
  // isolation-only artifact (the fold target) — create it only under isolation;
  // auto-repair-only needs just the SHA.
  if (isolationEnabled(manifest) || autoRepairEnabled(manifest)) {
    try {
      const baseSha = resolveBaseSha(defaultGitRunner, manifest.root, manifest.baseBranch);
      if (baseSha) {
        loom.baseSha = baseSha;
        if (isolationEnabled(manifest)) {
          loom.consolidationBranch = `telar/${loom.id}`;
          createConsolidationBranch(defaultGitRunner, manifest.root, loom.consolidationBranch, baseSha);
        }
        saveLoom(loom);
      }
    } catch (err) {
      appendEvent(loom.id, {
        type: "consolidate-setup-failed",
        message: err instanceof Error ? err.message : String(err),
      });
      loom.baseSha = undefined;
      loom.consolidationBranch = undefined;
    }
  }

  const woven = runWeave(loom, decomposition, {
    spawnChild: (sg) => {
      const existing = listChildLooms(loom.id).find((c) => c.subGoalId === sg.id);
      if (existing) {
        // Blocker #3: REUSE the child so its persisted attempts[].sessionId
        // resumes the prior builder session (executor.ts:924) and NO orphan is
        // created. Refresh the fields a steer/reject may have changed so the
        // resumed builder sees the new directive; KEEP attempts[] (the session
        // chain) intact. Do NOT re-wireChildBundle (leave the existing bundle;
        // steering folds into the prompt, not the contract).
        existing.prompt = sg.detail;
        existing.title = sg.title;
        if (!existing.contractRequired) existing.acceptanceCriteria = sg.acceptanceCriteria;
        existing.state = "queued";
        existing.error = null;
        saveLoom(existing);
        return existing;
      }
      const child = createLoom({
        project: loom.project,
        kind: sg.proofStrategy === "quickfix" ? "quickfix" : sg.proofStrategy === "bmad-story" ? "story" : "custom",
        title: sg.title,
        prompt: sg.detail,
        account: manifest.account,
        parentLoomId: loom.id,
        subGoalId: sg.id,
      });
      // Give the Thread its OWN Spec Bundle: root context files copied in,
      // objective narrowed to the SubGoal, contract filtered to its slice.
      wireChildBundle(loom.id, child, sg, rootAssertions, rootSynthesized);
      saveLoom(child);
      return child;
    },
    runChild: async (child) => {
      const runFn = deps.runLoomFn ?? executeLoom;
      const base: ExecuteOpts = {
        policy,
        accounts: deps.accounts,
        roster,
        abort,
        onState: saveLoom,
        onEvent: (ev) => appendEvent(child.id, ev),
        ...(opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {}),
      };
      // M6 build fan-out (flag-guarded, DEFAULT OFF). Rides on worktree
      // isolation. Flag-off on EITHER flag ⇒ block skipped ⇒ opts.buildFanout
      // undefined ⇒ executeLoom's single-builder branch ⇒ byte-identical.
      // Whole block try/caught: any planner throw falls through to the single
      // builder rather than crashing a runnable thread.
      if (buildFanoutEnabled(manifest) && isolationEnabled(manifest)) {
        try {
          const fanout = await planBuildFanout(child);
          if (fanout) {
            appendEvent(child.id, { type: "fanout-planned", pieces: fanout.pieces.length });
            return runFn(child, manifest, { ...base, buildFanout: fanout });
          }
        } catch (err) {
          appendEvent(child.id, {
            type: "fanout-skipped",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return runFn(child, manifest, base);
    },
    onState: saveLoom,
    onEvent: (ev) => appendEvent(loom.id, ev),
    abort,
    // Unit 6 (docs §8 MVP): the end-of-orchestration ALL-scope integration
    // verify producer. runWeave calls this once after the children fold up to
    // "ready"; the result (latestVerdict + an integration attempt) is recorded
    // additively on the root. Its own panel/gate events append to the root's
    // event stream via appendEvent.
    runIntegrationVerify: (l) =>
      runIntegrationVerify(l, manifest, {
        policy,
        accounts: deps.accounts,
        abort,
        emit: (ev) => appendEvent(l.id, ev),
      }),
    // M10.1 (orchestratorVerify ON, auto-repair OFF): OVERRIDE the plain
    // producer with the whole-verification — frozenLaneVerify forking the
    // CONSOLIDATION BRANCH (fall back to baseSha) and verifying the FULL
    // contract over the composed whole. A later key wins over the default above
    // (same later-key-wins mechanism envReview/autoRepair use). Flag-off the
    // spread is `{}` and the default stands ⇒ byte-identical.
    ...(orchestratorVerifyEnabled(manifest)
      ? {
          runIntegrationVerify: (l: Loom): Promise<IvResult | null> =>
            frozenLaneVerify(
              l,
              manifest,
              frozenDeps(l, undefined, { forkRef: l.consolidationBranch ?? l.baseSha, fullContract: true }),
            ),
        }
      : {}),
    // M4 (auto-repair master flag ON): replace the plain producer with the
    // guarded frozen-lane loop, and fire best-effort per-subGoal checkpoints.
    // Absent flag-off ⇒ the runIntegrationVerify path above is byte-identical.
    ...(autoRepairEnabled(manifest)
      ? {
          runAutoRepair: (l: Loom): Promise<IvResult | null> =>
            runAutoRepair(l, {
              // M10.1: when orchestratorVerify is also ON, the auto-repair
              // root-verify leg forks the consolidation branch and verifies the
              // full contract too (checkpoints below stay unset ⇒ baseSha/ALL).
              // Flag-off the extra is `{}` ⇒ baseSha / ALL slice, as today.
              verify: (target: Loom) =>
                frozenLaneVerify(
                  target,
                  manifest,
                  frozenDeps(
                    target,
                    undefined,
                    orchestratorVerifyEnabled(manifest)
                      ? { forkRef: target.consolidationBranch ?? target.baseSha, fullContract: true }
                      : {},
                  ),
                ),
              repair: (target: Loom, brief: string) =>
                runRepairThread(target, manifest, brief, {
                  policy,
                  accounts: deps.accounts,
                  abort,
                  emit: (ev) => appendEvent(target.id, ev),
                }),
              buildBrief: (_l: Loom, iv: IvResult) => buildIntegrationRepairBrief(iv),
              budget: () => rootRepairBudget(l),
              caps: { maxRepairIterations: 3, estCostPerRepair: EST_COST_PER_AGENT },
              now: () => Date.now(),
              onRound: () => saveLoom(l),
              emit: (ev) => appendEvent(l.id, ev),
            }),
          runCheckpoint: async (child: Loom): Promise<void> => {
            // Best-effort + pool/budget-gated: skip when there is no headroom for
            // one more verify, or the settled child has no subGoalId slice.
            if (!child.subGoalId) return;
            const b = rootRepairBudget(loom);
            if (b.maxCostUsd != null && b.maxCostUsd - b.spentUsd < EST_COST_PER_AGENT) return;
            const iv = await frozenLaneVerify(loom, manifest, frozenDeps(loom, child.subGoalId));
            if (iv) {
              appendEvent(loom.id, {
                type: "weave-verify",
                verification: iv.verification,
                gatesOk: iv.gatesOk,
                subGoalId: child.subGoalId,
                checkpoint: true,
              });
            }
          },
        }
      : {}),
    // M5 (setup agent flag ON): run the scoped setup agent in the `preparing`
    // window — bring the env lane up / author a missing servers.yaml before any
    // build child spawns. Absent flag-off (dep undefined), so preparing→running
    // is byte-identical to today (weave.ts skips the whole block). On
    // { ready:false } the weave lands needs-review/failed WITHOUT spawning
    // children — never `done` (moat).
    ...(setupAgentEnabled(manifest)
      ? {
          runSetup: (l: Loom) =>
            runSetupAgent(l, manifest, {
              account: deps.accounts?.[manifest.account],
              model: policy.dev,
              onEvent: (ev) => appendEvent(l.id, ev),
              cwd: l.worktree ?? manifest.root,
            }),
        }
      : {}),
  });

  // M3: finalize the review branch once the weave settles. Every done child
  // already folded its work onto the branch (on its own success path); this
  // only RECORDS the deliverable and drops it if it stayed empty (zero folds).
  // MOAT: no merge, no checkout of baseBranch, no state change — the branch is
  // a review artifact the human lands via acceptLoom. Guarded so a finalize
  // failure never rejects the dispatch chain.
  if (isolationEnabled(manifest) && loom.consolidationBranch) {
    return woven.then((result) => {
      try {
        const fin = finalizeConsolidation(result, manifest.root, defaultGitRunner);
        appendEvent(result.id, {
          type: "consolidated",
          branch: fin.dropped ? null : result.consolidationBranch,
          commits: fin.commits,
          dropped: fin.dropped,
        });
        saveLoom(result);
      } catch (err) {
        try {
          appendEvent(result.id, {
            type: "consolidate-finalize-failed",
            message: err instanceof Error ? err.message : String(err),
          });
        } catch {}
      }
      return result;
    });
  }
  return woven;
}

// Post-charter dispatch: UNIVERSAL ROUTING — every loom runs through runWeave.
function dispatchExecution(
  loom: Loom,
  manifest: ProjectManifest,
  deps: DispatcherDeps,
  abort: AbortController,
  opts: { maxAttempts?: number } = {},
): Promise<Loom> {
  // UNIVERSAL ROUTING: every loom runs through runWeave. A non-woven loom is
  // given a deterministic single-subgoal charter first (weave-of-one); a real
  // epic keeps its planner charter. Idempotent on re-dispatch — ensureWoven is a
  // no-op-or-refresh once the loom weaves, so spawnChild REUSES the same child.
  ensureWoven(loom);
  saveLoom(loom);
  return runWeaveWiring(loom, manifest, deps, abort, opts);
}

export function startLoom(input: StartLoomInput, deps: DispatcherDeps): Loom {
  const { manifest } = getProject(input.project);
  const loom = createLoom({
    project: input.project,
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    account: manifest.account,
  });
  loom.acceptanceCriteria = input.acceptanceCriteria;
  loom.target = input.target;
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  const scope = needsScoping({ acceptanceCriteria: input.acceptanceCriteria, charter: input.charter });

  if (!scope) {
    // FAST PATH — byte-identical to today's behavior. No draftCharter call,
    // no "scoping" state. This is the regression guarantee.
    if (isWoven(input.charter)) {
      // MOAT GUARD applies here too: a caller-supplied woven charter bypasses
      // draftCharter (and its validateCharter call in the scoping path below)
      // by going straight through the fast path, so without this check a
      // zero-required-subgoal decomposition would roll up vacuously "done"
      // (the M7.1 finding) via a route validateCharter never sees.
      const v = validateCharter(input.charter!);
      if (!v.ok) {
        loom.error = v.errors.join("; ");
        loom.state = "needs-review";
        appendEvent(loom.id, { type: "state", state: "needs-review" });
        saveLoom(loom);
        active.delete(loom.id);
        return loom;
      }
      loom.charter = input.charter;
      saveLoom(loom);
      runWeaveWiring(loom, manifest, deps, abort)
        .catch(onFailure)
        .finally(() => active.delete(loom.id));
      return loom;
    }

    if (input.charter) {
      loom.charter = input.charter;
    }
    // UNIVERSAL ROUTING (blocker #1): the dominant single-loom path becomes a
    // weave-of-one. Attach the deterministic single-subgoal charter (Fork C) and
    // run it through the SAME orchestrator every epic uses. The builder loop, the
    // repair leg, and the moat live UNCHANGED inside the one child's executeLoom
    // + rollupWeave.
    ensureWoven(loom);
    saveLoom(loom);
    runWeaveWiring(loom, manifest, deps, abort, { maxAttempts: input.maxAttempts })
      .catch(onFailure)
      .finally(() => active.delete(loom.id));
    return loom;
  }

  // SCOPING PATH — vague prompt, no acceptanceCriteria/charter supplied.
  const setState = (s: Loom["state"]) => {
    loom.state = s;
    appendEvent(loom.id, { type: "state", state: s });
    saveLoom(loom);
  };

  (async () => {
    setState("scoping");

    const charter = await (deps.draftCharterFn ?? draftCharterDefault)(
      { prompt: input.prompt, manifest, proofStrategy: input.proofStrategy },
      {
        account: deps.accounts?.[manifest.account],
        model: deps.policy?.dev,
        onEvent: (ev) => appendEvent(loom.id, ev),
      },
    );

    const v = validateCharter(charter);
    if (!v.ok) {
      loom.error = v.errors.join("; ");
      setState("needs-review");
      return loom;
    }

    loom.charter = charter;
    saveLoom(loom);

    const requiresHuman =
      manifest.charterPolicy === "human-required" ||
      (manifest.charterPolicy === "human-required-for-epics" && isWoven(charter) && !isSingleThreadWeave(charter));

    if (requiresHuman) {
      setState("charter-review"); // paused — awaits approveCharter
      return loom;
    }

    charter.approvedBy = `auto:${manifest.charterPolicy}`;
    saveLoom(loom);
    return dispatchExecution(loom, manifest, deps, abort, { maxAttempts: input.maxAttempts });
  })()
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return loom;
}

// Approve a Charter paused in "charter-review" and dispatch its execution.
// Returns false if the loom doesn't exist, isn't awaiting approval, or has no
// charter to approve.
export async function approveCharter(id: string, by: string, deps: DispatcherDeps): Promise<boolean> {
  const loom = getLoom(id);
  if (!loom || loom.state !== "charter-review" || !loom.charter) return false;

  loom.charter.approvedBy = by;
  saveLoom(loom);
  appendEvent(loom.id, { type: "charter-approved", by });

  const { manifest } = getProject(loom.project);
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, manifest, deps, abort)
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return true;
}

// M7 — Accept/Steer a servers.yaml proposal paused in "env-review" and
// re-dispatch VERIFY. Mirrors approveCharter's human gate + dispatch tail. On a
// weave-of-one the gate lives on the ROOT (rollupWeave lifted the child's
// env-review + proposedServers up — E10), so the human answers here and the
// re-dispatched root weave RESETS + re-verifies the child. The moat: a non-blank
// human `by` is REQUIRED (Telar never autonomously decides how to run the user's
// app); the accepted config is persisted to `.telar/servers.yaml`
// (writeAcceptedServersConfig) BEFORE re-dispatch, so the re-verify sees the
// recipe and reaches the live path — but a green re-verify still lands `ready`,
// never `done` (only acceptLoom + a human `by` promotes).
//   `config` present  = STEER (the human edited the proposal) → persist that.
//   `config` absent   = ACCEPT the proposal as-is → persist loom.proposedServers.
// Returns false if the loom doesn't exist, isn't in env-review, or has nothing
// to accept (no config + no proposal on the loom).
export async function approveEnv(
  id: string,
  by: string,
  config: ServersConfig | undefined,
  deps: DispatcherDeps,
): Promise<boolean> {
  const loom = getLoom(id);
  if (!loom || loom.state !== "env-review") return false;
  if (!by?.trim()) throw new Error("approveEnv requires a non-blank `by`");
  const accepted = config ?? loom.proposedServers;
  if (!accepted) return false;

  const { manifest } = getProject(loom.project);
  writeAcceptedServersConfig(manifest.root, accepted); // → .telar/servers.yaml
  loom.proposedServers = undefined; // clear the draft — it's now persisted
  saveLoom(loom);
  appendEvent(loom.id, { type: "env-approved", by });

  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, manifest, deps, abort) // re-dispatch VERIFY
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return true;
}

// M10.4 — ANSWER a loom parked in `blocked` by the pre-flight lane-viability
// gate: the bounded ask-once-persist human escalation. A DEDICATED verb (not an
// extension of steerLoom, whose directive folds into the BUILD prompt, and not
// resumeLoom, which takes no `by` and so fails the human-gate moat). Mirrors
// approveEnv's human gate + persist + dispatch tail. The moat:
//   - a non-blank human `by` is REQUIRED (bound server-side, never from the
//     request body) — `blocked` is a PARK waiting on the human, so it can only
//     leave via a verb that carries a human touch;
//   - persistence is POST-ACCEPT ONLY (after the `by` guard) and writes to TWO
//     distinct tiers: the gitignored `.telar/` recipe/runbook (never committed)
//     and the committable manifest promotion (telar.yaml) — so a future loom
//     with the same unviable-shape contract NEVER re-asks;
//   - it re-dispatches to `ready` AT MOST: dispatchExecution re-enters the
//     verified loop; a green re-verify lands `ready`, never `done`. answerBlocked
//     itself sets NO state other than clearing the blocked draft; the persistence
//     writes set no state; only acceptLoom + a human `by` ever reaches `done`.
// Returns false if the loom doesn't exist, isn't in `blocked`, or the answer
// carries no VIABILITY-MAKING input (no non-blank devCommand and no servers
// recipe). A runbook is OPTIONAL accompanying narrative — isLaneViable never
// consults it, so a runbook alone can't clear the pre-flight gate; a runbook-only
// answer is rejected like an empty one (loom stays `blocked`, draft intact).
export async function answerBlocked(
  id: string,
  by: string,
  answer: {
    devCommand?: string;
    servers?: ServersConfig;
    runbook?: string;
    gates?: ProjectManifest["gates"];
    mcpServers?: ProjectManifest["mcpServers"];
  },
  deps: DispatcherDeps,
): Promise<boolean> {
  const loom = getLoom(id);
  if (!loom || loom.state !== "blocked") return false;
  if (!by?.trim()) throw new Error("answerBlocked requires a non-blank `by`");

  const hasDevCommand = !!answer.devCommand?.trim();
  const hasRunbook = !!answer.runbook?.trim();
  const hasServers = !!answer.servers;
  // The accept-guard MUST be consistent with isLaneViable (executor.ts): the lane
  // becomes viable ONLY from a non-blank devCommand OR a servers recipe. A runbook
  // is OPTIONAL narrative isLaneViable NEVER reads, so it is never SUFFICIENT
  // alone — accepting a runbook-only answer would persist + clear the draft +
  // re-dispatch, and the re-dispatched pre-flight would immediately RE-PARK with a
  // freshly-recomputed question (the answer looks accepted but never resolves).
  // Reject a runbook-only (or fully-empty) answer exactly like an empty one
  // (mirrors approveEnv's `if (!accepted) return false`): no write, no draft
  // clear, no re-dispatch — the loom stays `blocked` with its draft intact.
  if (!hasDevCommand && !hasServers) return false;

  const { manifest } = getProject(loom.project);

  // POST-ACCEPT persistence (strictly after the non-blank `by` guard). Two
  // distinct tiers, kept separate: the gitignored `.telar/` (never committed) +
  // the committable manifest (telar.yaml). Neither write sets loom.state.
  if (hasServers) writeAcceptedServersConfig(manifest.root, answer.servers!); // → .telar/servers.yaml
  if (hasRunbook) writeAcceptedRunbook(manifest.root, answer.runbook!.trim()); // → .telar/runbook.md

  // Promote a learned devCommand (and optionally gates/mcpServers) onto the
  // committable manifest so the RE-DISPATCHED pre-flight — and every FUTURE loom
  // in this project — sees the recipe and proceeds past the gate, never re-parks.
  if (hasDevCommand || answer.gates || answer.mcpServers) {
    const merged: ProjectManifest = {
      ...manifest,
      ...(hasDevCommand ? { devCommand: answer.devCommand!.trim() } : {}),
      ...(answer.gates ? { gates: answer.gates } : {}),
      ...(answer.mcpServers ? { mcpServers: answer.mcpServers } : {}),
    };
    writeManifest(manifest.root, merged);
  }

  loom.blockedReason = undefined; // the draft is now persisted
  loom.blockedQuestion = undefined;
  loom.error = null;
  saveLoom(loom);
  appendEvent(loom.id, { type: "lane-answered", by });

  // Re-read the manifest AFTER the promotion write so the re-dispatched pre-flight
  // sees the newly-learned devCommand/recipe and proceeds past the gate.
  const { manifest: freshManifest } = getProject(loom.project);

  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  dispatchExecution(loom, freshManifest, deps, abort) // re-dispatch (re-verifies; lands `ready` at most)
    .catch(onFailure)
    .finally(() => {
      if (active.get(loom.id) === abort) active.delete(loom.id);
    });

  return true;
}

// docs/loom-model.md §5/§2 — a planning session calls this to get a loom id
// to write Spec Bundle files into, BEFORE the loom is "started". The loom
// exists on disk (draft:true, state "queued") so the god-view can render the
// bundle-in-progress, but it is not dispatched — that only happens at the
// commit moment, `startLoomFromBundle`.
export function createDraftLoom(input: { project: string; title: string; objective: string; account?: string }): Loom {
  const account = input.account ?? getProject(input.project).manifest.account;
  return createLoom({
    project: input.project,
    kind: "custom",
    title: input.title,
    // PROVISIONAL seed only — a first-use placeholder so the god-view has a
    // prompt/title before the planner writes the real objective. Once
    // spec/objective.md exists it is the single source of truth and
    // updateDraftObjectiveFromBundle overwrites both of these.
    prompt: input.objective,
    account,
    draft: true,
  });
}

// A concise title (~60 chars) derived from an objective: its first markdown
// heading, else its first sentence/line.
function titleFromObjective(objective: string): string {
  const heading = objective.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
  const firstLine = objective.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? objective;
  const base = (heading ? heading[1] : firstLine).trim();
  const sentence = base.split(/(?<=[.!?])\s/)[0].trim().replace(/\s+/g, " ");
  return sentence.length > 60 ? sentence.slice(0, 60).trimEnd() : sentence;
}

// docs/loom-model.md §5 — reconcile a DRAFT loom's prompt/title with the
// authoritative spec/objective.md the planner writes. objective.md is the
// single source of truth for a bundle loom's objective; the seed passed to
// createDraftLoom is a provisional placeholder this overwrites once real
// content exists. No-op unless the loom is a draft AND objective.md is present
// and non-trivial (so an empty/whitespace file never clobbers the seed).
export function updateDraftObjectiveFromBundle(loomId: string): void {
  const loom = getLoom(loomId);
  if (!loom || loom.draft !== true) return;
  const objective = readBundleFile(loomId, "objective.md")?.trim();
  if (!objective) return;
  loom.prompt = objective;
  loom.title = titleFromObjective(objective);
  saveLoom(loom);
}

// A meta-request to create/start the loom (or a bare pointer) is NOT an
// objective. Conservative by design — it only fires when such a phrase is the
// DOMINANT content, so a real objective that merely mentions "build" in passing
// still starts. The semantic guard is the planner system prompt; this is the
// hard backstop at the human-approved commit point.
const META_REQUEST = /\b(draft|create|make|start|build)\s+(the\s+|a\s+)?loom\b|never\s*mind|let'?s\s+work\s+on\b/gi;
const OBJECTIVE_GATE_MSG =
  "Write a concrete objective describing the change to make (not a request to create the loom) into objective.md, then start again.";

// Returns an error message if objective.md is not real work, else null.
function objectiveGateError(objective: string): string | null {
  if (!objective) return OBJECTIVE_GATE_MSG;
  const isMeta = META_REQUEST.test(objective);
  META_REQUEST.lastIndex = 0; // `g` flag makes .test stateful — reset
  if (!isMeta) return null;
  // Strip the meta phrase(s) and issue-number/punctuation noise; if barely any
  // real content remains, the objective is dominated by the meta-request.
  const remainder = objective.replace(META_REQUEST, " ").replace(/[#\d\s.,!?;:'"()\-]+/g, " ").trim();
  return remainder.length < 40 ? OBJECTIVE_GATE_MSG : null;
}

// The commit moment (docs/loom-model.md §5, §M.6): a session finalizes a
// draft loom's Spec Bundle and this is what turns it into a running loom.
// Provenance-gated (§M.6 — "a Loom can only start from human-approved
// provenance") and contract-gated (§M.1 — no falsifiable Verification
// Contract, no start), modeled on approveCharter's dispatch tail.
export async function startLoomFromBundle(
  loomId: string,
  by: string,
  deps: DispatcherDeps,
  opts?: { sessionId?: string; maxAttempts?: number },
): Promise<Loom> {
  let loom = getLoom(loomId);
  if (!loom) throw new Error(`loom not found: ${loomId}`);
  if (!loom.draft) throw new Error("loom is not a draft awaiting start");

  // PROVENANCE GATE — settable only by this (human-approved UI) action, never
  // the session agent; assertProvenance throws on a blank approver.
  const provenance: Provenance = { sessionId: opts?.sessionId, approvedBy: by, humanApprovedAt: Date.now() };
  assertProvenance(provenance);
  writeProvenance(loomId, provenance);

  // CONTRACT GATE — a bundle loom cannot start (and thus cannot reach ready)
  // without a falsifiable Verification Contract (§M.1).
  const { contract, errors } = readContract(loomId);
  if (!contract || errors.length) {
    throw new Error(`bundle has no valid verification contract: ${errors.join("; ")}`);
  }

  // RECONCILE (§5): make objective.md drive prompt/title before we commit, so
  // a started loom always weaves from the distilled objective, never the raw
  // chat seed — even if the tool path skipped the live reconcile. Re-read so
  // the draft->started write below carries the reconciled values.
  updateDraftObjectiveFromBundle(loomId);
  loom = getLoom(loomId)!;

  // OBJECTIVE-QUALITY GATE: the human-approved commit point rejects a bundle
  // whose objective is missing or is a meta-request to create the loom rather
  // than the change to make — otherwise the builder loops on "draft the loom".
  const gateErr = objectiveGateError(readBundleFile(loomId, "objective.md")?.trim() ?? "");
  if (gateErr) throw new Error(gateErr);

  // CROSS-PROCESS GUARD (docs/loom-model.md §M.8): the draft->started flip
  // below is a plain read-modify-write on loom.json with no file lock or
  // version check. Within a single Node process, JS run-to-completion
  // semantics already serialize two calls for the same loom id (no `await`
  // precedes the flip), but a second OS process racing this function could
  // still pass every gate above before either writes draft:false, and both
  // dispatch. An O_EXCL sentinel file makes the FIRST caller to reach here
  // (i.e. the first to actually pass all gates) win atomically; a concurrent
  // second caller fails fast here instead of double-dispatching. Placed after
  // the gates (not before) so a legitimate retry following a failed gate
  // check — e.g. a fixed-up contract on the same draft loom — is never
  // permanently blocked by a leftover marker from the earlier, failed call.
  try {
    fs.writeFileSync(path.join(loomDir(loomId), ".started"), String(Date.now()), { flag: "wx" });
  } catch {
    throw new Error(`loom ${loomId} is already starting or started (concurrent start)`);
  }

  // Sticky: once a contract was required to start, it stays required for
  // the loom's whole lifetime (executor.ts's runVerification enforces this).
  loom.contractRequired = true;
  loom.draft = false;
  saveLoom(loom);
  appendEvent(loomId, { type: "started", by });

  const { manifest } = getProject(loom.project);
  const abort = new AbortController();
  active.set(loom.id, abort);
  const onFailure = makeOnFailure(loom);

  // AUTO-WEAVE (docs/loom-model.md §5/§W): the human already approved this
  // bundle at the provenance point, so there is NO charter-review gate. An AI
  // planner reads the (frozen) Spec Bundle and MAY emit a decomposition; if it
  // does, we assign the charter and dispatchExecution fans the work across
  // Threads. The planner degrades to today's single-builder path on ANY
  // failure — a throw, a null/invalid charter, or a non-weaving one — so it can
  // never reject an already-started loom. Fire-and-forget with the same
  // persistence guard the other dispatch chains use; the synchronous `return
  // loom` below is unchanged.
  loom.state = "scoping";
  appendEvent(loomId, { type: "state", state: "scoping" });
  saveLoom(loom);

  (async () => {
    let charter: Charter | undefined;
    try {
      charter = await (deps.planWeaveFn ?? planWeaveFromBundle)(
        {
          loomId,
          objective: loom.prompt,
          bundleFiles: snapshotBundle(loomId).files,
          contract: readContract(loomId).contract,
          manifest,
        },
        {
          account: deps.accounts?.[manifest.account],
          model: (deps.policy ?? loadPolicy()).dev,
          onEvent: (ev) => appendEvent(loomId, ev),
        },
      );
    } catch {
      charter = undefined; // any planner failure -> single-builder fallback
    }

    if (charter) {
      const v = validateCharter(charter);
      if (v.ok && isWoven(charter)) {
        charter.approvedBy = "auto:weave-planner";
        loom.charter = charter;
        saveLoom(loom);
        appendEvent(loomId, { type: "charter-approved", by: "auto:weave-planner" });
      }
    }

    return dispatchExecution(loom, manifest, deps, abort, { maxAttempts: opts?.maxAttempts });
  })()
    .catch(onFailure)
    .finally(() => active.delete(loom.id));

  return loom;
}

const TERMINAL_STATES: ReadonlySet<Loom["state"]> = new Set(["done", "halted", "failed", "skipped"]);

// "Cancel" always means "stop this loom" — a live loom is aborted (the
// running executor handles its own transition to "halted"); a paused loom
// (charter-review/env-review/queued/ready/blocked/needs-review) has no live
// process to abort, so it's halted directly here instead (env-review is a
// paused, non-in-flight, non-terminal state, so cancel halts it just fine).
export function cancelLoom(id: string): boolean {
  const ctl = active.get(id);
  if (ctl) {
    ctl.abort();
    active.delete(id);
    return true;
  }

  const loom = getLoom(id);
  if (!loom || TERMINAL_STATES.has(loom.state)) return false;

  loom.state = "halted";
  loom.error = loom.error ?? "Cancelled by user.";
  appendEvent(id, { type: "state", state: "halted" });
  saveLoom(loom);
  return true;
}

// Shared re-dispatch tail for steer/reject (docs/loom-model.md §A): a loom
// leaves `ready`/`blocked` and re-enters the SAME verified loop the initial
// start uses (dispatchExecution) — so it RE-VERIFIES and can only land back in
// `ready`, never `done` (terminalStateForCompletedLoom). Fire-and-forget with
// the same persistence guard the other dispatch chains use. Any live process
// for this id (there is none from `ready`/`blocked`, but be defensive) is
// aborted first so we never run two executors against one loom.
function reDispatch(loom: Loom, deps: DispatcherDeps): void {
  const existing = active.get(loom.id);
  if (existing) existing.abort();

  const abort = new AbortController();
  const onFailure = makeOnFailure(loom);

  try {
    // Synchronous setup: getProject reads the project's telar.yaml and THROWS
    // if the project left the registry, or its manifest is unreadable with no
    // cached copy to self-heal from (a wiped-but-cached telar.yaml is restored
    // and does NOT throw). The caller (steer/reject/resume) has ALREADY persisted
    // this loom as "queued", so a raw throw here would strand it "queued" with no
    // runner forever. Route the
    // failure through the same makeOnFailure guard the async path uses — bounce
    // it back to "failed" with the real error — then RE-THROW so steer/reject/
    // resume propagate it to their routes (ok:false). Never a false-positive
    // terminal state, never a silent swallow.
    const { manifest } = getProject(loom.project);
    active.set(loom.id, abort);
    dispatchExecution(loom, manifest, deps, abort)
      .catch(onFailure)
      .finally(() => {
        // Only clear if still ours — a concurrent reDispatch may have replaced it.
        if (active.get(loom.id) === abort) active.delete(loom.id);
      });
  } catch (err) {
    if (active.get(loom.id) === abort) active.delete(loom.id);
    onFailure(err);
    throw err;
  }
}

// docs/loom-model.md §A — the owner may STEER: record a directive and
// re-dispatch so the loom continues and RE-VERIFIES; it never auto-promotes to
// `done`. Valid from the verified `ready` milestone AND (P5) from
// `needs-review` — steering an unverified loom re-enters the SAME verified
// loop, so an owner's "answer & resume" (a directive that answers the review
// question) needs no new verb. `by` is server-derived (never from the request
// body). The directive is recorded durably in the bundle steering log AND
// folded into the loom's prompt so the re-dispatched builder acts on it.
export async function steerLoom(id: string, directive: string, by: string, deps: DispatcherDeps): Promise<Loom> {
  if (!by?.trim()) throw new Error("steerLoom requires a non-blank `by`");
  if (!directive?.trim()) throw new Error("steerLoom requires a non-empty directive");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state !== "ready" && loom.state !== "needs-review") {
    throw new Error(`steer is only valid from 'ready' or 'needs-review' (loom is '${loom.state}')`);
  }

  appendSteering(id, { kind: "steer", text: directive, by });
  appendEvent(id, { type: "steered", directive, by });
  loom.prompt = `${loom.prompt}\n\n## Steering directive (${by})\n${directive.trim()}`;

  // Leave `ready`, re-enter the verified loop. Never jump to `done`.
  loom.state = "queued";
  loom.error = null;
  appendEvent(id, { type: "state", state: "queued" });
  saveLoom(loom);

  reDispatch(loom, deps);
  return loom;
}

// docs/loom-model.md §A — REJECT sends a loom back to work with feedback so it
// re-enters the verified loop; it never reaches `done`. Valid from `ready` (the
// owner is unhappy with green work), `blocked` (a paused loom the owner
// un-sticks with guidance), `needs-review` (P5 — the owner rejects an
// unverified loom's work outright rather than answering it), or `failed` (a
// dead-ended attempt the owner sends back with corrective feedback rather than
// abandoning), or `env-review` (M7 — the owner rejects the env proposal; the
// loom lands the honest needs-review terminal, the same as flag-off — no
// fabricated pass). `by` is server-derived.
export async function rejectLoom(id: string, feedback: string, by: string, deps: DispatcherDeps): Promise<Loom> {
  if (!by?.trim()) throw new Error("rejectLoom requires a non-blank `by`");
  if (!feedback?.trim()) throw new Error("rejectLoom requires non-empty feedback");
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (
    loom.state !== "ready" &&
    loom.state !== "blocked" &&
    loom.state !== "needs-review" &&
    loom.state !== "failed" &&
    loom.state !== "env-review"
  ) {
    throw new Error(
      `reject is only valid from 'ready', 'blocked', 'needs-review', 'failed', or 'env-review' (loom is '${loom.state}')`,
    );
  }

  appendSteering(id, { kind: "reject", text: feedback, by });
  appendEvent(id, { type: "rejected", feedback, by });
  loom.prompt = `${loom.prompt}\n\n## Rejection feedback (${by})\n${feedback.trim()}`;

  // M7 — rejecting the ENV proposal lands the HONEST needs-review terminal (the
  // same state a flag-off / no-server loom reaches), TERMINALLY. It does NOT
  // re-dispatch: with no accepted `.telar/servers.yaml`, a re-verify would
  // re-trigger the env-review gate — an infinite block the moat forbids. On a
  // weave-of-one the gate lives on the ROOT (E10 lift), so ALSO reset the
  // orphaned CHILD still parked in env-review (clear its draft + land it in
  // needs-review) so a later resume re-runs a clean child and a stale child
  // state can't be re-lifted. The owner steers/resumes from needs-review to retry.
  if (loom.state === "env-review") {
    loom.proposedServers = undefined; // the rejected draft is dead
    loom.state = "needs-review";
    loom.error = `Env proposal rejected: ${feedback.trim()}`;
    appendEvent(id, { type: "state", state: "needs-review" });
    saveLoom(loom);
    for (const child of listChildLooms(loom.id)) {
      if (child.state === "env-review") {
        child.proposedServers = undefined;
        child.state = "needs-review";
        child.error = `Env proposal rejected: ${feedback.trim()}`;
        appendEvent(child.id, { type: "state", state: "needs-review" });
        saveLoom(child);
      }
    }
    return loom;
  }

  // Back to work, re-entering the verified loop. Never `done`.
  loom.state = "queued";
  loom.error = null;
  appendEvent(id, { type: "state", state: "queued" });
  saveLoom(loom);

  reDispatch(loom, deps);
  return loom;
}

// docs/loom-model.md §A — RESUME is a no-feedback retry: send a stuck loom back
// into the SAME verified loop with no new directive. Valid from `failed` (a
// dead-ended attempt the owner wants re-run as-is), `needs-review`, or
// `blocked`. Like steer/reject it re-enters dispatchExecution and RE-VERIFIES,
// so it can only land back at `ready`, never jump to `done` (the moat holds).
export function resumeLoom(id: string, deps: DispatcherDeps): Loom {
  const loom = getLoom(id);
  if (!loom) throw new Error(`loom not found: ${id}`);
  if (loom.state !== "failed" && loom.state !== "needs-review" && loom.state !== "blocked") {
    throw new Error(`resume is only valid from 'failed', 'needs-review', or 'blocked' (loom is '${loom.state}')`);
  }

  appendEvent(id, { type: "resumed", from: loom.state });

  // Back to work, re-entering the verified loop. Never `done`.
  loom.state = "queued";
  loom.error = null;
  appendEvent(id, { type: "state", state: "queued" });
  saveLoom(loom);

  reDispatch(loom, deps);
  return loom;
}

export const activeLoomIds = (): string[] => [...active.keys()];

// The in-flight states — a loom in one of these is mid-run and expects a live
// runner in `active`. Distinct from the paused/awaiting states (charter-review,
// ready, blocked, needs-review — no runner by design) and the TERMINAL_STATES
// above (done, halted, failed, skipped — finished).
const IN_FLIGHT_STATES: ReadonlySet<Loom["state"]> = new Set([
  "queued",
  "scoping",
  "preparing",
  "running",
  "verifying",
]);

const RESTART_ERROR =
  "Interrupted by a server restart — resume to pick it back up (no work was lost that a re-run can't reproduce).";

// BOOT RECONCILIATION. The `active` map lives ONLY in this process's memory: a
// code edit hot-reloads the web server, killing every in-flight runner and
// wiping `active`, which strands each of those looms on disk in an in-flight
// state with no runner and no path forward. Called once at boot, this marks
// each genuinely-stranded loom `failed` with a human-readable reason so the
// AcceptancePanel offers "resume" (resume is valid from `failed`). A loom is
// STUCK only if its state is in-flight AND its id is NOT in activeLoomIds()
// (no live runner in THIS process) — paused/awaiting and terminal looms are
// left untouched. We do NOT auto-re-dispatch: a restart is usually a code
// change that would immediately re-kill them, and a mass re-dispatch would
// stampede the budget — leave them resumable. Each loom's writes are wrapped so
// one failure never aborts the whole sweep. Returns the reconciled list (for
// logging).
// The in-process ownership oracle — a loom is LIVE iff it's in THIS process's
// `active` map. Byte-identical to the old `activeLoomIds().includes(id)` check;
// factored out so reconcileStuckLooms can share the pure recovery table with
// the runner while flag-off collapsing to today's exact behavior.
const inProcessLiveness: Liveness = makeInProcessLiveness(activeLoomIds);

export function reconcileStuckLooms(liveness: Liveness = inProcessLiveness): { id: string; from: string }[] {
  const reconciled: { id: string; from: string }[] = [];
  for (const loom of listLooms()) {
    if (loom.parentLoomId) continue; // children recover via their root's re-weave (spawnChild reuse), never independently
    if (liveness(loom.id)) continue; // a live loom (this process's runner) is never touched
    // Delegate the per-state judgement to the ONE pure recovery table
    // (runner/recover.ts). The web's boot policy is deliberately CONSERVATIVE:
    // it does NOT auto-resume (a restart is usually a code change that would
    // re-kill the loom, and a mass re-dispatch would stampede the budget), so
    // ANY stranded in-flight loom — whatever finer action the runner would take
    // (resume/queued/halt) — is marked `failed` (resumable) here. `leave` /
    // `skip` (awaiting-human / terminal) are left untouched, exactly as before.
    // MOAT: `reconcileState` can only ever yield resume/queued/halt/leave/skip —
    // never `done` — so this sweep can never auto-complete a loom.
    const action: RecoverAction = reconcileState(loom.state);
    if (action === "leave" || action === "skip") continue;
    const from = loom.state;
    try {
      loom.state = "failed";
      if (!loom.error) loom.error = RESTART_ERROR;
      if ("updatedAt" in loom) loom.updatedAt = Date.now();
      appendEvent(loom.id, { type: "error", message: loom.error });
      appendEvent(loom.id, { type: "state", state: "failed" });
      saveLoom(loom);
      reconciled.push({ id: loom.id, from });
    } catch {
      // One loom's failed write must never abort the sweep.
    }
  }

  // M3 worktree reaper — reclaim crash-orphaned worktrees a killed process
  // couldn't remove in its finally. Iterates ALL looms (roots AND children,
  // unlike the stuck sweep above which skips children), groups by project root,
  // and force-removes any telar-wt-* worktree not owned by an in-flight loom.
  // A worktree is LIVE if its own loom is deemed live by the SAME injected
  // `liveness` oracle the stuck sweep above uses, OR its parent root is — so a
  // loom a runner still owns (flag-on: /active or a fresh lease) is never reaped
  // even though this WEB process's `activeLoomIds()` is empty. Flag-off the
  // oracle is `inProcessLiveness` (activeLoomIds), so the result is byte-identical
  // to the old in-process set membership. Consolidation BRANCHES are intentionally
  // NOT reaped (a telar/<id> branch from a crashed run is harmless — branch GC is
  // the human's call). Guarded so a non-git project / missing root is a no-op,
  // never a boot crash.
  try {
    const isLive = (l: Loom): boolean => liveness(l.id) || (l.parentLoomId ? liveness(l.parentLoomId) : false);
    const byRoot = new Map<string, { live: string[]; reclaim: Loom[] }>();
    for (const l of listLooms()) {
      if (!l.worktree) continue;
      let root: string;
      try {
        root = getProject(l.project).manifest.root;
      } catch {
        continue; // project left the registry / unreadable — skip
      }
      let g = byRoot.get(root);
      if (!g) {
        g = { live: [], reclaim: [] };
        byRoot.set(root, g);
      }
      // Preserve (never reap, never clear) a worktree that is either owned by a
      // live/in-flight loom OR carries the durable `worktreeRetained` flag — the
      // latter is set by executor cleanup when a WIP snapshot FAILED and the dir
      // was retained as the only surviving copy of the work. Everything else with
      // a recorded worktree is a TRUE orphan (crashed mid-build) and is reclaimed.
      const retained = l.worktreeRetained === true;
      if (isLive(l) || retained) g.live.push(l.worktree);
      else g.reclaim.push(l);
    }
    // Seed an empty live/reclaim group for EVERY registered project root, not
    // only roots that currently own a worktree-bearing loom — so the reaper's
    // `git worktree prune` + orphan sweep runs everywhere on every boot and
    // reclaims unrecorded frozen-verify (telar-wt-frozen-*) / fold-transient
    // (telar-wt-fold-*) dirs a killed process left behind. Each seed in its own
    // try/catch so one bad / non-git project never aborts the sweep.
    for (const p of listProjects()) {
      try {
        const root = p.entry.root;
        if (!byRoot.has(root)) byRoot.set(root, { live: [], reclaim: [] });
      } catch {}
    }
    for (const [root, g] of byRoot) {
      try {
        reapOrphanWorktrees(defaultGitRunner, root, g.live);
      } catch {}
      for (const l of g.reclaim) {
        try {
          l.worktree = undefined;
          saveLoom(l);
        } catch {}
      }
    }
  } catch {
    // the reaper is belt-and-suspenders — never let it abort boot reconciliation
  }

  return reconciled;
}

export function loadPolicy(): ModelPolicy {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "policy.json"), "utf8");
    return ModelPolicy.parse(JSON.parse(raw));
  } catch {
    return ModelPolicy.parse({});
  }
}

// M6 — the curated agent roster (~/.telar/roster.json). Mirrors loadPolicy():
// any read/parse error (missing file, malformed JSON, a schema-rejected field
// like a smuggled restrictTools) degrades to the empty roster {} — never a
// throw, never a widened capability wall.
export function loadRoster(): Roster {
  try {
    const raw = fs.readFileSync(path.join(telarDir(), "roster.json"), "utf8");
    return Roster.parse(JSON.parse(raw));
  } catch {
    return Roster.parse({});
  }
}
