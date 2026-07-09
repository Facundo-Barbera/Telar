// Epic roll-up & the wave scheduler (docs/loom-orchestrator.md §4/§11). An
// epic Loom never builds anything itself — it only spawns and folds up child
// Looms. rollupEpic is the ONLY path to "done": every required SubGoal's
// child must have independently reached "done" via executeLoom's decide().
// This is the composed moat — do not add another branch that returns "done".
import type { Loom } from "./looms";
import type { SubGoal, WorkUnitState } from "./schemas";

// Pure: no persistence, no agent calls — just fold child states up against
// the decomposition per the required-subgoal contract.
export function rollupEpic(
  children: Loom[],
  decomposition: SubGoal[],
): { state: WorkUnitState; error?: string } {
  const required = decomposition.filter((sg) => sg.required);
  const childBySubGoal = new Map<string, Loom>();
  for (const c of children) {
    if (c.subGoalId) childBySubGoal.set(c.subGoalId, c);
  }

  const allRequiredDone = required.every((sg) => childBySubGoal.get(sg.id)?.state === "done");
  if (allRequiredDone) return { state: "done" };

  const failedRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state === "failed");
  if (failedRequired) return { state: "failed", error: `${failedRequired.id}: failed` };

  const notDoneRequired = required.find((sg) => childBySubGoal.get(sg.id)?.state !== "done");
  if (notDoneRequired) return { state: "needs-review", error: `${notDoneRequired.id}: not done` };

  // Unreachable given the branches above, but keeps the function total.
  return { state: "needs-review", error: "unresolved" };
}

export type RunEpicDeps = {
  spawnChild: (sg: SubGoal) => Loom;
  runChild: (child: Loom) => Promise<Loom>;
  onState?: (epic: Loom) => void;
  onEvent?: (ev: { type: string } & Record<string, unknown>) => void;
  abort?: AbortController;
};

// Pure w.r.t. persistence — all side effects (spawning/running children,
// persisting the epic) come through injected deps, mirroring executeLoom.
export async function runEpic(epic: Loom, decomposition: SubGoal[], deps: RunEpicDeps): Promise<Loom> {
  const emit = (ev: { type: string } & Record<string, unknown>) => deps.onEvent?.(ev);
  const setState = (s: WorkUnitState) => {
    epic.state = s;
    emit({ type: "state", state: s });
    deps.onState?.(epic);
  };
  const isAborted = () => deps.abort?.signal.aborted === true;
  const halt = () => {
    setState("halted");
    return epic;
  };

  try {
    if (isAborted()) return halt();

    setState("preparing");

    const finished = new Map<string, Loom>(); // subGoalId -> done/terminal child
    const run = new Set<string>(); // subGoalId already spawned+run
    let startedRunning = false;

    while (true) {
      if (isAborted()) return halt();

      const remaining = decomposition.filter((sg) => !run.has(sg.id));
      if (remaining.length === 0) break;

      const wave = remaining.filter((sg) => sg.dependsOn.every((dep) => finished.get(dep)?.state === "done"));
      if (wave.length === 0) break; // blocked: unmet deps or a dep child not "done"

      if (!startedRunning) {
        setState("running");
        startedRunning = true;
      }

      const spawned = wave.map((sg) => {
        const child = deps.spawnChild(sg);
        emit({ type: "epic-child-spawned", subGoalId: sg.id, childId: child.id });
        return { sg, child };
      });
      for (const { sg } of spawned) run.add(sg.id);

      const ran = await Promise.all(spawned.map(({ child }) => deps.runChild(child)));
      for (let i = 0; i < spawned.length; i++) {
        finished.set(spawned[i]!.sg.id, ran[i]!);
      }

      if (isAborted()) return halt();
    }

    const children = [...finished.values()];
    const r = rollupEpic(children, decomposition);
    epic.error = r.error ?? null;
    setState(r.state);
    emit({ type: "epic-rollup", state: r.state });
    return epic;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (isAborted()) return halt();
      emit({ type: "error", message });
      epic.error = message;
      setState("failed");
    } catch {
      epic.state = isAborted() ? "halted" : "failed";
      if (epic.state === "failed") epic.error ??= message;
    }
    return epic;
  }
}
