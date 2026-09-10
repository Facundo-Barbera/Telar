/**
 * `RunCapability` over the real store and manager — the daemon's copy.
 *
 * THE SESSION CONTEXT IS INJECTED, not read out of engine state, so this file
 * imports nothing that would drag the whole daemon into a unit test. The
 * daemon's mount point supplies a resolver that answers "which project is this
 * session's, and which tree is it sitting on"; every rule about singletons,
 * ownership and redaction lives below in the manager, which is what makes the
 * HTTP surface and the toolkit incapable of disagreeing.
 */
import type { RunCapability, RunStatusAnswer } from "./capability";
import type { RunManager } from "./manager";
import type { RunStore } from "./store";
import { redactConfiguration, RunError, type RunConfigurationInput, type RunView } from "./types";

/** Who is asking, and from where. Resolved per call: a worktree can move. */
export type RunSessionContext = {
  sessionId: string;
  projectId: string;
  /** Absolute path of the tree this session works in. */
  worktreePath: string;
  worktreeBranch?: string;
};

export type RunDeps = {
  store: RunStore;
  manager: RunManager;
  context: () => RunSessionContext;
};

export function storeRunCapability(deps: RunDeps): RunCapability {
  const { store, manager } = deps;

  /**
   * Resolve which run a call is about. `finished: "allow"` is for READS only:
   * the most useful output to read is usually from the run that just died, so
   * `run_output` with no id falls back to the newest run, while stop, restart
   * and release keep refusing when nothing is actually deployed.
   */
  const target = (runId?: string, finished: "allow" | "refuse" = "refuse"): RunView => {
    const { projectId } = deps.context();
    if (runId) {
      const run = manager.run(runId);
      // A run id from another project is a mistake worth naming rather than a
      // cross-project action worth performing.
      if (run.projectId !== projectId) throw new RunError("not_found", `no run ${runId} in this project`);
      return run;
    }
    const active = manager.activeRun(projectId);
    if (active) return active;
    const latest = finished === "allow" ? manager.history(projectId)[0] : undefined;
    if (!latest) throw new RunError("not_found", "nothing is running for this project");
    return latest;
  };

  return {
    async configurations() {
      const { projectId } = deps.context();
      return store.list(projectId).map(redactConfiguration);
    },

    async createConfiguration(input: RunConfigurationInput) {
      const { projectId } = deps.context();
      return redactConfiguration(store.create(projectId, input));
    },

    async updateConfiguration(configId, patch) {
      const { projectId } = deps.context();
      return redactConfiguration(store.update(projectId, configId, patch));
    },

    async removeConfiguration(configId) {
      const { projectId } = deps.context();
      store.remove(projectId, configId);
    },

    async status(): Promise<RunStatusAnswer> {
      const context = deps.context();
      const active = manager.activeRun(context.projectId);
      return {
        ...(active ? { active } : {}),
        history: manager.history(context.projectId),
        sessionWorktreePath: context.worktreePath,
      };
    },

    async start({ configId, replace }) {
      const context = deps.context();
      const config = store.get(context.projectId, configId);
      const input = {
        projectId: context.projectId,
        config,
        worktreePath: context.worktreePath,
        ...(context.worktreeBranch ? { worktreeBranch: context.worktreeBranch } : {}),
        sessionId: context.sessionId,
      };
      return replace ? await manager.replace(input) : await manager.start(input);
    },

    async stop(input) {
      return await manager.stop(target(input?.runId).runId);
    },

    async restart(input) {
      return await manager.restart(target(input?.runId).runId);
    },

    async release({ runId }) {
      return manager.release(target(runId).runId);
    },

    async output(input) {
      return manager.output(target(input?.runId, "allow").runId, input?.after ?? 0);
    },
  };
}
