import { type RunState, writeRunState } from "./lib/runState";
import { OBJECTIVE_MD, ROADMAP_MD, buildContract, buildWovenCharter } from "./spec";

// Authors the Spec Bundle and dispatches a bundle loom with an INJECTED woven
// planner. Returns after dispatch — the executor then runs fire-and-forget IN
// THIS PROCESS, so the caller MUST keep the process alive (watchUntilReady).
export async function run(state: RunState): Promise<string> {
  // 1. bind isolation env, then import core.
  process.env.TELAR_HOME = state.telarHome;
  const core = await import("@telar/core");

  // 2. create the draft (bundle) loom — kind:"custom", draft:true.
  const loom = core.createDraftLoom({
    project: state.projectName,
    title: "Greenfield Next.js E2E",
    objective: OBJECTIVE_MD,
  });
  const loomId = loom.id;

  // 3. persist loomId immediately, BEFORE dispatch, so watch/teardown know it.
  state.loomId = loomId;
  writeRunState(state);

  // 4. author the Spec Bundle (lands at <telarHome>/looms/<loomId>/spec/).
  //    writeContract validates — throws on an unfalsifiable contract.
  core.writeBundleFile(loomId, "objective.md", OBJECTIVE_MD);
  core.writeBundleFile(loomId, "roadmap.md", ROADMAP_MD);
  core.writeContract(loomId, buildContract());

  // 5. DispatcherDeps with an injected woven planner — this is what FORCES
  //    orchestration (invariant #1): the returned Charter is always woven.
  const accounts = Object.fromEntries(core.listAccounts().map((a) => [a.name, a]));
  const basePolicy = core.loadPolicy();
  const policy = { ...basePolicy, maxTurns: Number(process.env.TELAR_E2E_MAX_TURNS ?? 400) };
  const planWeaveFn: typeof core.planWeaveFromBundle = async () => buildWovenCharter();
  const deps = { accounts, policy, planWeaveFn };

  // 6. commit + dispatch — stamps contractRequired (invariant #2). Returns
  //    synchronously after dispatch; the executor now runs IN THIS PROCESS.
  await core.startLoomFromBundle(loomId, "telar-e2e-harness", deps);

  // 7. print loomId + watch URL.
  console.log("loomId: " + loomId);
  if (state.webServerPort) console.log("watch:  http://127.0.0.1:" + state.webServerPort + "/looms/" + loomId);

  // 8. return
  return loomId;
}

// Standalone: dispatch, then HOST the executor to completion via watch so the
// in-process executor is not abandoned when this process would otherwise exit.
if (import.meta.main) {
  (async () => {
    const { readRunState, findLatestRunDir } = await import("./lib/runState");
    const i = process.argv.indexOf("--run");
    const runDir = i !== -1 ? process.argv[i + 1] : (process.env.TELAR_E2E_RUN_DIR ?? findLatestRunDir());
    if (!runDir) throw new Error("no run dir: pass --run <dir> or run setup.ts first");
    const state = readRunState(runDir);
    const loomId = await run(state);
    const { watchUntilReady } = await import("./watch");
    const finalState = await watchUntilReady(state, loomId);
    console.log("final loom state: " + finalState);
    process.exit(finalState === "ready" ? 0 : 1);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
