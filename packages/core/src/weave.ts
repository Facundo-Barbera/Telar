// The weave roll-up & the weaver's control loop (docs/loom-orchestrator.md
// §4/§6/§7/§11; vocabulary per docs/loom-model.md §W). A woven root Loom
// never builds anything itself — it only spawns and folds up child Looms
// (threads). rollupWeave is the ONLY completion path: every required
// SubGoal's child must have independently reached "done" via executeLoom's
// decide() (children keep landing on "done" — the woven root is the thing
// the owner accepts, so it rolls up to "ready", never "done" —
// docs/loom-model.md §A). This is the composed moat — do not add another
// branch that returns "ready"/"done" here.
import type { AttemptRecord, Loom } from "./looms";
import type { Charter, PanelReport, SubGoal, WorkUnitState } from "./schemas";
import { MEDIATION_BUDGET, readySubGoals, tick, validateDecision, type Decision, type LedgerView, type ThreadView } from "./tick";
import type { BudgetState } from "./budget";
import { ledgerReadUnavailable, ledgerSpendUsd, logUsage } from "./usage-ledger";
import type { GateResult } from "./gates";

// Pure: no persistence, no agent calls — just fold child states up against
// the decomposition per the required-subgoal contract.
export function rollupWeave(
  children: Loom[],
  decomposition: SubGoal[],
): { state: WorkUnitState; error?: string } {
  const required = decomposition.filter((sg) => sg.required);
  // Defense-in-depth against the M7.1 vacuous-"done" hole: validateCharter
  // (scoping.ts) already rejects a zero-required decomposition before it
  // reaches runWeave via dispatcher.ts, but rollupWeave is exported public
  // API (index.ts) — guard here too so a caller that bypasses
  // validateCharter can't make `required.every(...)` trivially true.
  if (required.length === 0) {
    return { state: "needs-review", error: "decomposition has zero required subgoals (invalid charter)" };
  }
  const childBySubGoal = new Map<string, Loom>();
  for (const c of children) {
    if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
  }

  // A required child is "met" at "done" (terminalStateForCompletedLoom always
  // returns "done" for a loom with parentLoomId set — §A). "ready" is included
  // too: it is the SAME "verified" terminal per the WorkUnitState enum
  // ("ready, // verified, awaiting owner acceptance") — a child never lands
  // there in production (only a root/verify-root does), so this widens nothing
  // reachable from executeLoom; it only keeps rollupWeave honest for callers
  // (fakes/harnesses) that hand it an already-verified child stamped "ready".
  const isMet = (state: WorkUnitState | undefined) => state === "done" || state === "ready";
  const allRequiredDone = required.every((sg) => isMet(childBySubGoal.get(sg.id)?.state));
  // §A: the woven root is the thing the owner accepts — it lands "ready",
  // never "done", even though the gate is still every required child === "done".
  if (allRequiredDone) return { state: "ready" };

  // Cut 0 mustFix FIX 1 — compute the COMPLETE unmet-required enumeration ONCE
  // and use it as the reason for EVERY non-ready outcome (failed AND blocked).
  // The old code short-circuited on the first failed (or first blocked) required
  // child with a single-id message (`${id}: failed` / `${id}: blocked`) BEFORE
  // this enumeration ever ran — hiding every other unmet required subgoal,
  // including ones that never spawned at all. State selection is unchanged: any
  // required child failed => `failed` (decisive red, a genuinely failed child
  // still fails the weave); else any required child blocked OR any unmet
  // required => `blocked` (L1/L6, contract mandate 4 — a root with
  // unbuilt/unproven required work never settles into a state that presents an
  // accept affordance, and `needs-review` for a ROOT stays reserved for the
  // composed-proof demote — runWeave's integration-verify block below — never
  // for missing work). Only the REASON's shape changed: it is always the
  // complete enumeration, one label per unmet required subgoal in decomposition
  // order, joined "; " — never the old single-id shape (run #3's "F: not done"
  // while 4/6 subgoals were never spawned, or the failed/blocked short-circuits
  // burying siblings).
  const unmet = required.filter((sg) => !isMet(childBySubGoal.get(sg.id)?.state));
  const label = (sg: SubGoal): string => {
    const child = childBySubGoal.get(sg.id);
    if (!child) return `${sg.id}: unspawned`;
    if (child.state === "failed") return `${sg.id}: failed`;
    if (child.state === "blocked") return `${sg.id}: blocked`;
    return `${sg.id}: not done (${child.state})`;
  };
  const detail = unmet.map(label).join("; ");
  const anyFailed = unmet.some((sg) => childBySubGoal.get(sg.id)?.state === "failed");
  return { state: anyFailed ? "failed" : "blocked", error: detail };
}

export type RunWeaveDeps = {
  spawnChild: (sg: SubGoal) => Loom;
  runChild: (child: Loom) => Promise<Loom>;
  onState?: (loom: Loom) => void;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  abort?: AbortController;
  // Injected clock — tick/validateDecision stay pure (no Date.now inside
  // them); runWeave reads `now()` once per tick and passes it through the
  // LedgerView. Defaults to the wall clock outside tests.
  now?: () => number;
  // Unit 6 (docs §8 MVP): end-of-orchestration ALL-scope integration verify
  // PRODUCER. Injected so weave.ts stays pure w.r.t. persistence AND free of
  // any executor import — it only calls this runner and records the result.
  // Returns null when there is no ALL contract to verify (no-op, back-compat).
  // Production wires the exported runIntegrationVerify (executor.ts); tests
  // inject a fake. Pushes an integration AttemptRecord onto the loom before it
  // returns; weave records latestVerdict + emits weave-verify + persists.
  runIntegrationVerify?: (loom: Loom) => Promise<{
    verification: string;
    gatesOk: boolean;
    panelReport?: PanelReport | null;
    gates?: GateResult[];
  } | null>;
  // M4 (auto-repair) — REPLACES runIntegrationVerify at the
  // terminal hook. Runs the frozen-lane read-only verify and, on a red ALL
  // verdict, a bounded provably-terminating repair loop (repair-guard.ts).
  // Returns the FINAL verify result: converged ⇒ pass/skip keeps "ready"
  // (never "done"); escalate ⇒ fail/flaky demotes ready→needs-review carrying
  // the guard reason on loom.error (which this dep sets). Absent (not injected,
  // e.g. in a test) ⇒ the runIntegrationVerify path above runs instead.
  runAutoRepair?: (loom: Loom) => Promise<{
    verification: string;
    gatesOk: boolean;
    panelReport?: PanelReport | null;
    gates?: GateResult[];
  } | null>;
  // M4 checkpoint — a BEST-EFFORT per-subGoal integration verify fired when a
  // child folds. Informational + non-blocking: it never gates the weave, never
  // mutates root state, and is pool-gated / slice-gated inside the dep itself
  // (skipped when there is no room or no assertions). Absent flag-off.
  runCheckpoint?: (child: Loom) => Promise<void>;
  // M5 — pre-build environment bring-up (the setup agent). Runs in the
  // `preparing` window, immediately after setState("preparing") and BEFORE the
  // first build child spawns. Absent flag-off, so the preparing→running
  // transition is byte-identical to today. On { ready:false } the weave does
  // NOT proceed to spawn children: the root lands needs-review (never done).
  runSetup?: (loom: Loom) => Promise<{ ready: boolean; wroteServersYaml?: boolean; error?: string }>;
  // B2 (§22-24,§62) — THE ORCHESTRATOR-MEDIATION LEG. Given a settled non-done
  // required child (failed / blocked / needs-review) that tick chose to `repair`,
  // produce a REMEDIATED child: re-derive / reassign / repair the thread. The
  // per-thread budget is enforced by the tick kernel (MEDIATION_BUDGET) — this
  // dep performs ONE bounded correction attempt and returns the new child state.
  // Absent (not injected, e.g. in a test) ⇒ mediation degrades to a fresh
  // REASSIGNMENT via the existing spawnChild/runChild seam: a clean re-attempt of
  // the subgoal (its own inner loop re-plans/re-verifies). Production (B2 step 2)
  // wires the richer runRepairThread / spawnChild-reuse / re-plan path here.
  mediateThread?: (child: Loom, sg: SubGoal) => Promise<Loom>;
};

// AD-18 — the idempotency key for ONE billable attempt: the pair (loom id, that
// attempt's OWN minted id). `AttemptRecord.id` (looms.ts) is stamped by
// executor.ts at the four sites that create an attempt, and loom.json carries it
// from then on. usage-ledger.ts folds a non-empty entryKey AT MOST ONCE, so
// re-presenting an attempt that is already on the ledger writes a line that
// changes no total. That is what makes recording safe at every settle, after
// every mediation, and again on the next resume — including a resume that runs
// in a DIFFERENT PROCESS, which is the case an "already recorded" Set held by
// this closure could never cover.
//
// THE RULE THIS ENCODES, learned the expensive way: A BILLING KEY MUST BE A
// UNIQUE ID MINTED AT THE MOMENT THE MONEY IS SPENT, CARRIED ON THE RECORD, AND
// NEVER RE-DERIVED FROM POSITION, ORDER OR COUNT. Three earlier shapes keyed on
// something COUNTABLE — the attempts[] index, then the index plus startedAt —
// and each one ANNIHILATED money. usage-ledger.ts's own header names "a dev
// server and the packaged app appending to one root concurrently" as
// legitimate: both processes read the same persisted child, both see
// attempts.length === k, and both push a GENUINELY DIFFERENT attempt at index k.
// A key built from that position is ONE key for TWO events; the fold keeps the
// first and drops the second, and real money disappears with no ledger row and
// no event. MEASURED on the index+startedAt shape: two attempts stamped in the
// same millisecond (Date.now() has millisecond resolution, so this is not
// hypothetical), or two attempts carrying no finite startedAt at all, billed $4
// against $11 of real work. A minted id closes it because it is not a position:
// nothing else can ever land on it.
//
// DIRECTION OF ERROR, which is why that was worse than the cumulative-sum
// over-count the keys replaced: an over-count is visible and arguable, an
// under-count silently un-binds maxCostUsd.
//
// IDENTITY MUST SURVIVE PERSISTENCE, which is why the id is a FIELD and not an
// object identity: the same attempt re-presented after a JSON round-trip —
// loom.json out and back in, i.e. the resume shape — carries the same id, mints
// the same key and folds to nothing. A WeakMap, a Symbol or an in-memory
// sequence number would bill it a second time on every resume.
//
// WHY NOT AttemptRecord.n: `n` is not unique within one attempts[]. The build
// loop restarts it at 1 on every executeLoom call (executor.ts:1873), the
// verify path hardcodes `n: 1` (:1512), and two other producers use
// `attempts.length + 1` (:1206, :1392) — so a resumed child genuinely holds
// [n=1, n=2, n=1, …] and keying on `n` would fold real money away. Nor
// `sessionId`, which is DELIBERATELY shared across resumed attempts (:1888).
//
// LEGACY RECORDS — every loom.json written before AttemptRecord.id existed, and
// only those. They keep the PREVIOUS key shape, (loom id, index, startedAt),
// with its bare (loom id, index) fallback for a record carrying no finite
// startedAt. That shape is unsafe only when two writers append CONCURRENTLY at
// one index, and a historical attempt is frozen — nothing re-pushes it — so this
// branch runs only over data that can no longer grow. It still dedupes such a
// record against itself, which is all a record with no minted id can offer. The
// `typeof` guard is deliberate: a non-string / empty id (a hand-edited or
// foreign loom.json) takes the legacy branch rather than collapsing every
// attempt of one loom onto the single key `attempt:<loomId>:`.
//
// WHAT THE LEGACY BRANCH RESTS ON — and ONLY that branch, now that an id-bearing
// attempt is named by its id instead of its slot: attempts[] is APPEND-ONLY
// everywhere in packages/core/src — only createLoom's `attempts: []`
// (looms.ts:338) and four `.push(...)` sites (executor.ts:1211/1397/1513/1894)
// exist; nothing assigns into it, splices, pops, shifts, reorders or truncates
// it — so an index names the same attempt for the life of the record. A future
// writer that REWROTE an existing index would have its correction silently
// deduped away with no other test failing, so test/weave.test.ts scans
// packages/core/src for every shape that could do it: replacing the array,
// assigning into an index, deleting an index, truncating via `.length`, and
// splice/pop/shift/unshift/sort/reverse/fill/copyWithin. A fixture test beside
// it proves the scan discriminates (every violating shape caught, every shape
// production actually uses today ignored), because a scan whose patterns stopped
// matching would otherwise pass just as quietly as a clean tree.
//
// HOW THE SCAN IS ANCHORED — MEASURED, not asserted, because the earlier version
// of this comment claimed more than the scan delivers. ELEVEN of the twelve
// patterns are anchored on a BARE `attempts` identifier, so each of them matches
// through an alias of that name as well as through a `.attempts` property write.
// The TWELFTH — replacing the array wholesale — is anchored on the `.attempts`
// PROPERTY write ONLY and does NOT match a bare `attempts = […]`. That is a
// deliberate anchor rather than a hole of the same kind: reassigning a local
// alias only re-points the local name, it cannot reach the array the loom (and
// loom.json) still holds, so it cannot move any index. The shapes that DO reach
// the underlying array through an alias are the in-place ones, and those are
// exactly the eleven anchored on the bare identifier. The anchor also keeps
// `const attempts = …`, how a legitimate read binding reads (tick.ts:232), from
// being a standing false positive.
//
// WHAT THE SCAN DOES NOT COVER, so the assumption above is not claimed to be
// fully proven: it is a TEXT scan over packages/core/src, so an alias under
// some OTHER name, a computed member access, an object rebuilt around a fresh
// attempts array, or a rewrite performed outside packages/core/src all evade
// it — and nothing can see a loom.json that arrives already carrying a
// rewritten history.
const attemptKey = (unit: Loom, attempt: AttemptRecord, index: number) =>
  typeof attempt.id === "string" && attempt.id !== ""
    ? `attempt:${unit.id}:${attempt.id}`
    : Number.isFinite(attempt.startedAt)
      ? `attempt:${unit.id}:${index}:${attempt.startedAt}`
      : `attempt:${unit.id}:${index}`;

// L13 (contract mandate 5) — the minimal honest projection of a settled child's
// WorkUnitState onto the SubGoal.status enum (pending/ready/active/done/blocked/
// failed). done⇒done, a terminal failure⇒failed, an awaiting-orchestrator park⇒
// blocked, anything still moving⇒active. NOT authoritative — a sync of child state
// for the record/UI (tick.ts derives scheduling from live child state, never this).
function subGoalStatusFor(childState: WorkUnitState): SubGoal["status"] {
  switch (childState) {
    case "done":
      return "done";
    case "failed":
    case "halted":
      return "failed";
    case "blocked":
    case "needs-review":
      return "blocked";
    default:
      return "active";
  }
}

// Pure w.r.t. persistence — all side effects (spawning/running children,
// persisting the woven root) come through injected deps, mirroring
// executeLoom. INTERNALS ONLY changed from the naive wave scheduler to the
// tick loop (docs/loom-orchestrator.md §6/§7); the exported signature is
// unchanged.
export async function runWeave(loom: Loom, decomposition: SubGoal[], deps: RunWeaveDeps): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => deps.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    loom.state = s;
    emit({ type: "state", state: s });
    deps.onState?.(loom);
  };
  const isAborted = () => deps.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return loom;
  };
  const now = deps.now ?? (() => Date.now());
  // L13 (contract mandate 5) — persist SubGoal.status at the REAL transition so
  // loom.json reads truthfully WITHOUT cross-joining every child loom. A SYNC of
  // authoritative child state onto the charter record: saveLoom (via deps.onState)
  // writes the whole loom, charter included. `sg` is an element of `decomposition`
  // (= loom.charter.decomposition), so the mutation reaches disk.
  const syncSubGoalStatus = (sg: SubGoal, status: SubGoal["status"]) => {
    if (sg.status === status) return;
    sg.status = status;
    deps.onState?.(loom);
  };

  // AD-18 — the spend WRITE leg: ONE keyed ledger row per attempt that actually
  // cost money, attributed to the ROOT loom (so weave.ts's own `spentUsd`
  // projection over loom/<rootId> keeps answering the same question). Idempotent
  // by construction via attemptKey, so this may be called at every settle, after
  // every mediation, and again on the next resume — the repeats fold to nothing.
  // The shape it replaces wrote the child's CUMULATIVE attempt sum on EVERY
  // settle, so a $1 attempt plus a $5 repair billed 1 + 6 = $7 for $6 of work,
  // durably and on every resume.
  //
  // A ZERO-COST ATTEMPT WRITES NO ROW: there is no money to bill yet, and an
  // attempt that later acquires a cost is billed then, under its own key. The
  // epsilon rather than `=== 0` because attempt.costUsd is accumulated ADDITIVELY
  // (`x = (x ?? 0) + …` — executor.ts:738 for critic lenses, :1706 for split
  // pieces), and float residue must never burn a key on a row worth nothing.
  //
  // ACCOUNTING IS BEST-EFFORT, THE WORK IS NOT. logUsage can throw — ENOSPC /
  // EACCES / EROFS on mkdirSync/appendFileSync, or the NODE_ENV=test guard — and
  // a throw escaping here would reach runWeave's outer catch and mark the whole
  // weave `failed`, discarding children that had already settled successfully.
  // Every row therefore gets its own try/catch, and the report is ONE-SHOT (a
  // boolean, never a counter — this closure accumulates no money) so a
  // persistent EROFS cannot flood events.ndjson with a line per attempt per
  // settle.
  //
  // PRECONDITION: call this only on a unit whose attempt-producing work has
  // SETTLED. First-occurrence-wins is irreversible, so recording a still-
  // accumulating attempt would burn a partial figure into its key permanently.
  //
  // HOW THE TWO CALL SITES BELOW SATISFY IT — MEASURED, because the earlier
  // wording here ("both call sites follow an `await`") is true of only ONE of
  // them. What actually holds for both is the same guarantee reached two ways:
  // the unit each site records is the RESOLVED value of that unit's runner
  // promise.
  //   - The settle site is the body of `deps.runChild(child).then((result) => …)`.
  //     That callback is NOT async and contains NO `await` before the call — it
  //     runs BECAUSE the runner promise resolved, and `result` is what it
  //     resolved to.
  //   - The mediation site does lexically follow an `await` (of
  //     deps.mediateThread, or of deps.runChild on the degraded path), and
  //     records that await's value.
  // RESIDUAL, stated rather than claimed away: neither mechanism can rule out a
  // runner that resolves while a DETACHED continuation keeps accumulating into
  // the same AttemptRecord (executor.ts adds to attempt.costUsd additively).
  // Nothing in packages/core/src does that today, and a resolved runner is the
  // strongest settle signal this seam has.
  let spendRecordFailed = false;
  let spendSkipReported = false;
  // One reporter for BOTH ways a row can fail to land — a throw out of
  // logUsage, and logUsage returning false. They are the same event to a human
  // reading events.ndjson (money that is not on the ledger) and they share the
  // one-shot flag for the same reason: a persistent cause repeats per attempt
  // per settle.
  const reportSpendRecordFailed = (unitId: string, index: number, message: string) => {
    if (spendRecordFailed) return;
    spendRecordFailed = true;
    try {
      emit({ type: "spend-record-failed", unitId, attempt: index, message });
    } catch {
      /* best-effort */
    }
  };
  const recordSpend = (unit: Loom) => {
    unit.attempts.forEach((a, index) => {
      const costUsd = a.costUsd ?? 0;
      if (!Number.isFinite(costUsd)) {
        // A NaN/Infinity cost must not vanish silently — that is the same class
        // of defect as a ledger that drops a malformed entry with no report.
        if (!spendSkipReported) {
          spendSkipReported = true;
          try {
            emit({ type: "spend-record-skipped", unitId: unit.id, attempt: index, reason: "non-finite cost" });
          } catch {
            /* even the accounting event is best-effort */
          }
        }
        return;
      }
      if (Math.abs(costUsd) < 1e-9) return;
      try {
        // THE RETURNED BOOLEAN IS READ, not discarded. logUsage reports a
        // schema rejection by returning false rather than throwing
        // (usage-ledger.ts's logUsage), so a `try`/`catch` alone leaves exactly
        // the hole the ledger's own silent-drop finding named one level down:
        // the row never lands, the loom's own durable log says nothing, and the
        // only trace is a console line nobody tailing this run will see.
        const logged = logUsage({
          ts: now(),
          account: loom.account,
          model: "",
          // Loom spend belongs to no chat session; the empty value also keeps it
          // out of the session-scoped projections.
          sessionId: "",
          ownerKind: "loom",
          ownerId: loom.id,
          costUsd,
          entryKey: attemptKey(unit, a, index),
        });
        if (!logged) {
          reportSpendRecordFailed(
            unit.id,
            index,
            "logUsage rejected the entry — it is NOT on the ledger (usage-ledger.ts prints the failing fields)",
          );
        }
      } catch (e) {
        reportSpendRecordFailed(unit.id, index, e instanceof Error ? e.message : String(e));
      }
    });
  };

  try {
    if (isAborted()) return halt();

    setState("preparing");

    // M5 setup agent (flag-on only): bring the env lane up / author a missing
    // servers.yaml before ANY build child spawns. Absent flag-off (dep
    // undefined) this whole block is skipped, so preparing→running is
    // byte-identical to today. On { ready:false } the weave STOPS here without
    // spawning children — the root lands needs-review carrying the setup error.
    // MOAT: never `done`; awaiting-human by design. An aborted setup halts.
    if (deps.runSetup) {
      const setup = await deps.runSetup(loom);
      if (isAborted()) return halt();
      if (!setup.ready) {
        loom.error = setup.error ?? "setup: environment not ready";
        emit({ type: "setup-failed", message: loom.error });
        setState("needs-review");
        return loom;
      }
      emit({ type: "setup-ready", wroteServersYaml: setup.wroteServersYaml === true });
    }

    // A LedgerView-shaped charter: decomposition is always the param passed
    // in (mirrors rollupWeave's own signature), other fields come from
    // loom.charter when present, else safe woven-root defaults — tests
    // routinely run a woven Loom with no charter at all.
    const baseCharter = loom.charter;
    const charterView: Charter = {
      objective: baseCharter?.objective ?? loom.title,
      proofStrategy: baseCharter?.proofStrategy ?? "custom",
      scope: baseCharter?.scope ?? { allowedPaths: [], forbiddenPaths: [] },
      budget: baseCharter?.budget ?? { maxParallelThreads: 3, maxAgents: 12, maxCriticAgents: 3 },
      decomposition,
      version: baseCharter?.version ?? 1,
      approvedBy: baseCharter?.approvedBy,
      scopingSessionId: baseCharter?.scopingSessionId,
      rationale: baseCharter?.rationale,
    };
    const maxAgents = charterView.budget.maxAgents;
    const maxCostUsd = charterView.budget.maxCostUsd;
    const maxWallClockHours = charterView.budget.maxWallClockHours;
    const startedAtMs = now();

    const finished = new Map<string, Loom>(); // subGoalId -> done/terminal child
    const runningThread = new Map<string, ThreadView>(); // subGoalId -> in-flight summary
    const running = new Map<string, Promise<void>>(); // subGoalId -> settlement tracker
    // B2 — orchestrator-mediation attempts spent per subgoal. Feeds the tick
    // kernel (via currentThreads) so it emits `repair` only while a thread's
    // count is < MEDIATION_BUDGET, then escalates (the human park). Strictly
    // increments on each mediation ⇒ the rung is provably terminating.
    const mediationAttempts = new Map<string, number>(); // subGoalId -> mediations spent
    // M4: in-flight best-effort checkpoint verifies (never awaited inline so
    // they don't block the weave; drained before rollup so none detaches).
    const checkpoints: Promise<void>[] = [];
    const decisionLog: Decision[] = [];
    // AD-18 — a loom's spend is a PROJECTION over the one usage ledger, folded
    // fresh at each read, never a counter this closure accumulates. Spend
    // already recorded for this loom (a prior run, or anything else that
    // attributed to it) is therefore visible in the very first decision's
    // budget instead of restarting from zero.
    //
    // WHY A FAILED READ MAY NOT ANSWER 0: budget.spentUsd is a GUARD input.
    // Answering 0 makes budgetLeftUsd (budget.ts) report the FULL maxCostUsd as
    // headroom, so capByBudget stops binding and the weave keeps spending — a
    // money guard failing OPEN, and the reader has no way to tell that answer
    // apart from a real ledger with nothing on it yet.
    //
    // WHY A try/catch AROUND THE READ IS NOT THE GUARD — MEASURED, not assumed.
    // usage-ledger.ts's readFold answers an I/O failure with a FOLD and never a
    // throw (foldAfterFailedRead), so the catch below cannot fire for the
    // failure it exists to catch: with $100 on the ledger, a $1 maxCostUsd and
    // an EACCES on the first ledger touch of a fresh process, the read returned
    // 0, that 0 was recorded as a SUCCESS, the cap stopped binding, a child
    // spawned and the root reached `ready` — with no event emitted anywhere.
    // The distinguishing signal has to come from the port itself:
    // ledgerReadUnavailable() is true only when the most recent fold-producing
    // read FAILED and there was no cached fold to serve. A successful read of an
    // absent or genuinely empty ledger is a real 0 and stays one. The catch is
    // kept as a BACKSTOP for a read path that one day does throw.
    //
    // WHAT THIS NOW GUARANTEES, in the three cases that differ:
    //  - UNAVAILABLE, WITH A LAST-KNOWN VALUE ⇒ re-serve it. The ledger is
    //    append-only, so a stale total is a LOWER BOUND on the truth: the guard
    //    can only UNDER-state spend by whatever landed since, and it keeps
    //    binding at that figure instead of resetting to zero.
    //  - UNAVAILABLE, NO LAST-KNOWN VALUE (the COLD case) and a maxCostUsd
    //    actually caps this weave ⇒ FAIL CLOSED by throwing, which runWeave's
    //    outer catch turns into `failed` carrying the reason. There is no stale
    //    figure to under-state here, so the only other answers are 0 (the
    //    fail-open above) or a fabricated number. Two properties make the throw
    //    the right mechanism rather than a budget-shaped sentinel: it discards
    //    no settled work — the cold branch is reachable only while no read has
    //    ever succeeded, the loop reads spentUsd once per iteration BEFORE it
    //    can schedule anything, and the first success leaves a last-known value
    //    forever after, so nothing has spawned yet — and it puts the real cause
    //    on loom.error, where a human reads it. Feeding tick a huge spentUsd
    //    instead would land the root `blocked` under tick's "the agent pool has
    //    no room" reason and let rollupWeave overwrite loom.error with a
    //    subgoal enumeration, naming everything except the unreadable ledger.
    //    HEAD failed the run here too (its unguarded ledger call threw), so this
    //    restores that bar rather than regressing it.
    //  - NO maxCostUsd ⇒ 0, and the weave runs. Nothing can be un-bound by a
    //    number no guard consults, and an uncapped weave must not be stopped by
    //    an accounting defect. The 0 is NOT retained as a last-known value, so a
    //    later successful read still installs the real one.
    // NEVER SILENT: whichever branch fires, the one-shot `spend-read-failed`
    // event is emitted first — a boolean, not a counter, so a persistent failure
    // cannot flood events.ndjson once per tick.
    //
    // RESIDUAL, STATED RATHER THAN CLAIMED AWAY:
    //  - A TRANSIENT cold failure (EMFILE, a racing chmod) on the first read
    //    fails a capped weave that would have been fine. There is no retry here.
    //    Chosen deliberately: an over-strict stop is visible and arguable, a
    //    silently un-bound maxCostUsd is not.
    //  - The stale value served on the warm path is only as good as the last
    //    successful read. Spend that lands while the ledger is unreadable is
    //    invisible to the guard, so maxCostUsd can still be overshot by that
    //    amount — bounded by what the run spends before a read succeeds again.
    //  - The event is one-shot per RUN, so a read that fails, recovers and fails
    //    again reports only the first.
    let spendReadFailed = false;
    let lastSpentUsd: number | null = null;
    const reportSpendReadFailed = (message: string) => {
      if (spendReadFailed) return;
      spendReadFailed = true;
      try {
        emit({ type: "spend-read-failed", message });
      } catch {
        /* best-effort */
      }
    };
    const spentUsd = (): number => {
      let why = "the usage ledger could not be read and no cached fold was available";
      try {
        const spent = ledgerSpendUsd({ ownerKind: "loom", ownerId: loom.id });
        if (!ledgerReadUnavailable()) {
          lastSpentUsd = spent;
          return spent;
        }
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      reportSpendReadFailed(why);
      if (lastSpentUsd !== null) return lastSpentUsd; // stale, never zeroed — the guard keeps binding
      if (maxCostUsd == null) return 0; // uncapped: no guard consults this number
      throw new Error(`spend read unavailable with no last-known value under maxCostUsd — ${why}`);
    };
    let startedRunning = false;

    // The live thread set (finished + in-flight), in the exact shape tick reads.
    // Shared by the loop body and the observe-delta so both see one truth.
    const currentThreads = (): ThreadView[] => [
      ...[...finished.entries()].map(([subGoalId, child]) => ({
        id: child.id,
        subGoalId,
        state: child.state,
        runnerInFlight: false, // settled: its runChild promise resolved → terminal
        mediationAttempts: mediationAttempts.get(subGoalId) ?? 0, // B2: mediations spent
      })),
      ...[...runningThread.values()].map((t) => ({ ...t, runnerInFlight: true })),
    ];
    // The ready subgoal set right now, via the pure scheduler primitive — so the
    // observe event's "unblocked" delta matches tick's own readiness definition.
    const readyIdsNow = (): string[] =>
      readySubGoals({
        charter: charterView,
        threads: currentThreads(),
        inFlight: running.size,
        budget: { maxAgents, inFlight: running.size, spentUsd: spentUsd(), startedAtMs, maxCostUsd, maxWallClockHours },
        decisionLogTail: [],
        nowMs: now(),
      });

    // Unit 3 — PLAN event at weave start: the decomposition graph + the one
    // genuinely LLM-authored rationale (Charter.rationale). For a synthesized
    // weave-of-one (charterView drops `singleThread`, so read it off baseCharter)
    // an honest deterministic string stands in.
    emit({
      type: "plan",
      decomposition: decomposition.map((sg) => ({
        id: sg.id,
        title: sg.title,
        dependsOn: sg.dependsOn,
        required: sg.required,
      })),
      rationale:
        charterView.rationale ??
        (baseCharter?.singleThread ? "single thread by construction — no decomposition requested" : null),
    });

    const spawn = (sg: SubGoal) => {
      const child = deps.spawnChild(sg);
      emit({ type: "weave-child-spawned", subGoalId: sg.id, childId: child.id });
      syncSubGoalStatus(sg, "active"); // L13 — the subgoal is now being built
      runningThread.set(sg.id, { id: child.id, subGoalId: sg.id, state: "running" });
      // Attach the recording .then BEFORE this promise is placed into
      // `running` — since it always runs strictly before the wrapper
      // promise settles, every await on Promise.race(running.values())
      // below is guaranteed to observe the completed thread already moved
      // out of `running`/`runningThread` and into `finished`.
      const settle = deps.runChild(child).then((result) => {
        // Ready set BEFORE recording the settle (child still counts as running).
        const readyBefore = new Set(readyIdsNow());
        finished.set(sg.id, result);
        syncSubGoalStatus(sg, subGoalStatusFor(result.state)); // L13 — settled: done/failed/blocked
        recordSpend(result); // one keyed row per NEW attempt; re-records fold to nothing
        runningThread.delete(sg.id);
        running.delete(sg.id);
        // Unit 4 — OBSERVE event: which child settled, its rollup state, and the
        // subgoals THIS settle newly unblocked (ready now, not ready a moment ago).
        const unblocked = readyIdsNow().filter((id) => !readyBefore.has(id));
        emit({ type: "observe", subGoalId: sg.id, childId: result.id, state: result.state, unblocked });
        // M4 checkpoint (flag-on only): a best-effort per-subGoal integration
        // verify against the assembled-so-far whole, the moment this child
        // folds "done". Non-blocking (not awaited here) + informational: the
        // dep is pool-gated and never mutates root state. A "done" child is the
        // only one with a coherent contribution to check.
        if (deps.runCheckpoint && result.state === "done") {
          checkpoints.push(
            deps.runCheckpoint(result).catch((e) => {
              try {
                emit({ type: "weave-verify-error", message: e instanceof Error ? e.message : String(e) });
              } catch {
                /* best-effort */
              }
            }),
          );
        }
      });
      running.set(sg.id, settle);
    };

    // Base scheduling headroom (4 ticks/subgoal + slack) PLUS the B2 mediation
    // budget: each subgoal may be re-derived up to MEDIATION_BUDGET times, and
    // every mediation costs one repair-tick plus one re-observe tick — 2 per
    // attempt. Without this the safety bound would trip mid-mediation (still
    // safe — it escalates — but this keeps the bound honest w.r.t. the rung).
    const maxIterations = decomposition.length * (4 + 2 * MEDIATION_BUDGET) + 8;
    let iterations = 0;

    while (true) {
      if (isAborted()) return halt();

      iterations++;
      if (iterations > maxIterations) {
        loom.error = "weaver exceeded its safety iteration bound";
        break;
      }

      const budget: BudgetState = {
        maxAgents,
        inFlight: running.size,
        spentUsd: spentUsd(),
        startedAtMs,
        maxCostUsd,
        maxWallClockHours,
      };
      const view: LedgerView = {
        charter: charterView,
        threads: currentThreads(),
        inFlight: running.size,
        budget,
        decisionLogTail: decisionLog.slice(-8),
        nowMs: now(),
      };

      // Unit 2 — the rationale rides alongside the decision. tick computes it
      // purely from `view`; the loop folds in only validateDecision's reason,
      // which is otherwise thrown away when an invalid decision is downgraded.
      const { decision, rationale } = tick(view);
      let d: Decision = decision;
      const v = validateDecision(d, view);
      if (!v.ok) {
        d = { action: "hold" }; // never apply an invalid decision
        rationale.rejected = v.reason; // (d) the reason the original decision was rejected
      }

      decisionLog.push(d);
      emit({ type: "decision", decision: d, rationale });

      if (d.action === "schedule") {
        if (!startedRunning) {
          setState("running");
          startedRunning = true;
        }
        for (const id of d.subGoalIds) {
          const sg = decomposition.find((s) => s.id === id);
          if (!sg) continue; // defensive: tick only proposes ready decomposition ids
          spawn(sg);
        }
        continue; // do NOT await — re-tick to keep filling the pool
      }

      if (d.action === "hold") {
        if (running.size === 0) {
          loom.error = "no ready threads and none in flight (blocked)";
          break;
        }
        await Promise.race(running.values());
        continue;
      }

      if (d.action === "finish-loom") {
        break;
      }

      if (d.action === "escalate") {
        loom.error = d.reason ?? "escalated";
        break;
      }

      // B2 (§22-24,§62) — THE ORCHESTRATOR-MEDIATION HANDLER. tick emits `repair`
      // for a settled non-done required thread while its per-thread budget
      // remains (see tick.ts). MEDIATE FIRST: re-derive / reassign the thread and
      // fold the remediated child back in, then re-tick. The tick kernel bounds
      // the loop — it stops emitting `repair` and escalates once mediationAttempts
      // reaches MEDIATION_BUDGET — so this can never spin. On exhaustion the
      // human parks stay the final valve (§73-74): the rollup below lifts a
      // still-blocked child's question up to the root.
      if (d.action === "repair") {
        // Resolve the settled child this directive targets (tick only emits
        // `repair` for a finished thread, so it lives in `finished`).
        let targetSubGoalId: string | undefined;
        let targetChild: Loom | undefined;
        for (const [sgId, c] of finished.entries()) {
          if (c.id === d.threadId) {
            targetSubGoalId = sgId;
            targetChild = c;
            break;
          }
        }
        const sg = targetSubGoalId ? decomposition.find((s) => s.id === targetSubGoalId) : undefined;
        if (!sg || !targetChild) {
          // Defensive: an unknown/absent mediation target — do not spin.
          loom.error = `mediation target ${d.threadId} not found`;
          break;
        }
        const attempt = (mediationAttempts.get(sg.id) ?? 0) + 1;
        mediationAttempts.set(sg.id, attempt);
        emit({
          type: "mediate",
          subGoalId: sg.id,
          childId: targetChild.id,
          attempt,
          priorState: targetChild.state,
        });
        // ONE bounded correction attempt: the richer re-derive/repair when
        // wired, else a fresh reassignment via the spawnChild/runChild seam.
        syncSubGoalStatus(sg, "active"); // L13 — the subgoal is being re-attempted (mediation re-dispatch)
        const remediated = deps.mediateThread
          ? await deps.mediateThread(targetChild, sg)
          : await deps.runChild(deps.spawnChild(sg));
        if (isAborted()) return halt();
        finished.set(sg.id, remediated);
        syncSubGoalStatus(sg, subGoalStatusFor(remediated.state)); // L13 — remediated child resettled
        recordSpend(remediated); // the remediation's new attempts; its earlier ones are already keyed
        emit({
          type: "mediate-result",
          subGoalId: sg.id,
          childId: remediated.id,
          state: remediated.state,
          attempt,
        });
        continue; // re-tick: converged ⇒ progress, still non-done ⇒ mediate again or park
      }

      // Any other unexpected action — escalate defensively rather than loop.
      loom.error = "unhandled decision";
      break;
    }

    // Every break path above (finish-loom / escalate / maxIterations /
    // unhandled) leaves the loop without awaiting whatever is still in
    // `running` — draining here (rather than at each break site) closes that
    // gap once for all of them. deps.runChild's own .then (in spawn(), above)
    // already moves each settling child from running/runningThread into
    // finished as it lands, so this simply lets rollup observe the true final
    // state of every spawned child instead of abandoning in-flight work to a
    // detached promise the caller can no longer see, cancel, or account for.
    if (running.size > 0) {
      await Promise.allSettled([...running.values()]);
    }
    // M4: drain any best-effort checkpoint verifies so none detaches past the
    // weave's lifetime. Each already carries its own catch — informational.
    if (checkpoints.length > 0) {
      await Promise.allSettled(checkpoints);
    }

    const children = [...finished.values()];
    const r = rollupWeave(children, decomposition);
    // rollup is authoritative for state: a genuinely "ready" rollup (every
    // required child done) always wins, clearing any stray escalate/
    // iteration-bound error string.
    loom.error = r.state === "ready" ? null : (r.error ?? loom.error ?? null);
    // FINDING 8 — carry a `blocked` rollup's
    // parked child's HUMAN-facing question (blockedReason/blockedQuestion) up onto
    // the ROOT before setState so the existing blocked cockpit (form + Discuss)
    // renders the ask on the thing the human interacts with, and record WHICH child
    // /subgoal it came from (lane-escalation) for the event stream. The
    // integration-verify block below is gated r.state === "ready", so blocked
    // correctly skips it (nothing to verify on an awaiting-human park).
    if (r.state === "blocked") {
      // Cut 0 mustFix FIX 2 — ONE deterministic primary-attribution rule: the
      // primary blocked child is the FIRST required subgoal in DECOMPOSITION
      // order whose child actually parked blocked. The old code picked here via
      // SETTLE order (`children` = [...finished.values()]) while rollupWeave's
      // own (now-folded-in) selection walked decomposition order — with two
      // simultaneously blocked required children the two could name DIFFERENT
      // subgoals, and the blocked-root page renders ONLY blockedQuestion/
      // blockedReason (acceptance-panel.tsx, the M10.4 "never diverge"
      // invariant), so the OTHER blocked child was hidden with nothing naming
      // it. Deriving `primarySg` from `decomposition` (not from `children`'s
      // settle order) puts this pick and the rollup enumeration on the same
      // `required` sequence over the same settled child states.
      const childBySubGoal = new Map<string, Loom>();
      for (const c of children) {
        if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
      }
      const primarySg = decomposition.find(
        (sg) => sg.required && childBySubGoal.get(sg.id)?.state === "blocked",
      );
      const bChild = primarySg ? childBySubGoal.get(primarySg.id) : undefined;
      if (bChild && primarySg) {
        // A required child PARKED blocked — lift its answerable question to the
        // root verbatim. blockedQuestion is the at-a-glance headline, and it
        // names the first PARKED required subgoal, because only a parked child
        // carries a question a human can answer. When ANOTHER required child is
        // simultaneously blocked, blockedReason (the full BlockedEscalation
        // panel copy) names it too and carries the complete FIX 1 enumeration,
        // so no second PARKED child hides behind the headline — the
        // single-parked-child case (the overwhelming common path) stays
        // byte-identical: just the child's own reason, nothing appended.
        //
        // WHAT THIS DOES NOT COVER, SO IT IS NOT CLAIMED: the headline is NOT
        // always the subgoal loom.error leads with. loom.error is FIX 1's
        // complete unmet-required enumeration and also lists required work that
        // is merely unspawned or not-done; when such a subgoal precedes the
        // parked one in decomposition order, the enumeration leads with it
        // while the headline names the parked child (decomposition [s1
        // dependsOn s2, s2 parks blocked] gives error "s1: unspawned; s2:
        // blocked" under an "s2 question?" headline). `otherBlocked` appends
        // only the other BLOCKED children, so in that case blockedReason stays
        // the parked child's own reason and the unspawned/not-done remainder
        // reaches the human through loom.error alone — which the blocked page
        // named above does not render. Closing that is a UI/attribution change,
        // not a comment fix, so it is recorded here rather than asserted away.
        const otherBlocked = decomposition.filter(
          (sg) => sg.required && sg.id !== primarySg.id && childBySubGoal.get(sg.id)?.state === "blocked",
        );
        loom.blockedReason =
          otherBlocked.length > 0
            ? `${bChild.blockedReason ?? "blocked"} (also blocked: ${otherBlocked
                .map((sg) => sg.id)
                .join(", ")}; full: ${r.error})`
            : bChild.blockedReason;
        loom.blockedQuestion = bChild.blockedQuestion;
        emit({ type: "lane-escalation", by: "telar", childId: bChild.id, subGoalId: bChild.subGoalId });
      } else {
        // L1/L6 (contract mandate 4) — the root parks blocked because required work
        // is UNBUILT/UNPROVEN (unspawned or spawned-but-not-done), not because a child
        // asked a question. Surface the COMPLETE enumerated reason (rollupWeave's
        // r.error) as the root's human-facing ask so the cockpit shows exactly which
        // required subgoals are missing — never a bare accept affordance.
        loom.blockedReason = r.error ?? "required subgoals unmet";
        loom.blockedQuestion =
          "Required subgoals are unbuilt or unproven. Re-plan or reassign the missing threads, or override with a named justification.";
        emit({ type: "lane-escalation", by: "telar", reason: "required-subgoals-unmet", subGoalId: loom.subGoalId });
      }
    }
    setState(r.state);
    // L6 (contract mandate 4) — account for EVERY spawned child (required AND
    // non-required) in the record so a failed optional child never silently vanishes:
    // the rollup event carries each subgoal's final child state and whether it was
    // required. `children` is one settled child per subgoal (finished, drained above).
    emit({
      type: "weave-rollup",
      state: r.state,
      children: children.map((c) => ({
        subGoalId: c.subGoalId,
        state: c.state,
        required: decomposition.find((sg) => sg.id === c.subGoalId)?.required ?? false,
      })),
    });

    // Unit 6 (docs §8 MVP): integration verify PRODUCER. Runs strictly AFTER
    // setState(r.state) so the rollup state still wins — this is INFORMATIONAL,
    // it never mutates loom.state or any finish/accept semantics (Unit 7 gates
    // on it). Gated on r.state === "ready" (every required child self-reported
    // done, weave.ts §A): exactly the §2 case where children each self-reported
    // and no ALL verify has ever run — the whole point of catching a broken
    // assembled whole. A failed/needs-review assembly has nothing coherent to
    // integration-verify. A woven root with no ALL contract -> null -> no-op.
    // M4 (auto-repair): runAutoRepair REPLACES the plain
    // producer — it drives the frozen-lane verify and, on a red ALL verdict,
    // the bounded guarded repair loop, then returns the FINAL verdict. When
    // runAutoRepair is absent (not injected) the runIntegrationVerify path runs
    // instead. Either way the demote/keep semantics below are unchanged.
    const verifyProducer = deps.runAutoRepair ?? deps.runIntegrationVerify;
    if (r.state === "ready" && verifyProducer) {
      // Best-effort: its OWN try/catch so a throw — a rejecting runner, or a
      // saveLoom/appendEvent disk error inside the block — can NEVER reach the
      // outer catch and demote a correctly-woven "ready" loom to "failed". An
      // informational verify must not change the outcome: record the error and
      // drop it; the authoritative rollup state stands.
      try {
        const iv = await verifyProducer(loom); // null => no ALL contract
        if (iv) {
          loom.latestVerdict = iv.verification;
          emit({ type: "weave-verify", verification: iv.verification, gatesOk: iv.gatesOk });
          // Unit 7 (docs §8): the ALL verdict is AUTHORITATIVE for the terminal
          // state. A REAL red verdict (the ALL verify RAN and did not pass)
          // demotes the self-reported "ready" to "needs-review" — the assembled
          // whole can then only be closed via an AUDITED owner override, never a
          // clean accept. "pass"/"skip" keep "ready". A THROW never reaches here
          // (caught below) — fail-open: a broken checker is not a red verdict, so
          // it must not demote a correctly-woven loom.
          if (iv.verification === "fail" || iv.verification === "flaky") {
            // M4: runAutoRepair may already have set loom.error to the guard's
            // escalate reason ("no progress" / "regression: …" / "max repair
            // iterations" / budget). Preserve it; fall back to the generic
            // string flag-off (where loom.error is null after a ready rollup, so
            // this is byte-identical to the pre-M4 assignment).
            loom.error = loom.error ?? `integration verification ${iv.verification}`;
            setState("needs-review"); // emits {type:"state"} + persists via deps.onState
          } else {
            deps.onState?.(loom); // "pass"/"skip": persist the recorded verdict; state unchanged
          }
        }
      } catch (e) {
        try {
          emit({ type: "weave-verify-error", message: e instanceof Error ? e.message : String(e) });
        } catch {
          /* even the error event is best-effort — never let it demote the loom */
        }
      }
    }
    return loom;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      loom.error = message;
      setState("failed");
    } catch {
      loom.state = isAborted() ? "halted" : "failed";
      if (loom.state === "failed") loom.error ??= message;
    }
    return loom;
  }
}
