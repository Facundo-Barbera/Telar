/**
 * `RunCapability` over the real store and manager — the daemon's copy.
 *
 * THE SESSION CONTEXT IS INJECTED, not read out of engine state, so this file
 * imports nothing that would drag the whole daemon into a unit test. The
 * daemon's mount point supplies a resolver that answers "which session, which
 * project, and which tree is it sitting on"; every rule about ownership and
 * redaction lives below it, which is what makes the HTTP surface and the
 * toolkit incapable of disagreeing.
 */
import type { RunCapability, RunStatusAnswer, RunTarget } from "./capability";
import type { RunManager } from "./manager";
import type { RunStore } from "./store";
import { isTerminal, redactConfiguration, RunError, type RunConfigurationInput, type RunView } from "./types";

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
   * Resolve which terminal a call is about — ALWAYS ONE OF THIS SESSION'S.
   *
   * An id from another session is `not_found` rather than acted on: a
   * terminal belongs to the session whose panel it is in, and a conversation
   * closing somebody else's dev server by a pasted id is the mistake this
   * refuses.
   *
   * WITH NO ID, `reads` fall back to the newest terminal, open or not — the
   * most useful output is usually from the one that just ended — while every
   * verb that ACTS needs exactly one open terminal to mean. With two open the
   * answer names them, because guessing which dev server to close is how the
   * wrong one goes.
   */
  const target = (input: RunTarget | undefined, mode: "read" | "act"): RunView => {
    const { sessionId } = deps.context();
    const id = input?.terminalId ?? input?.runId;
    if (id) {
      let run: RunView;
      try {
        run = manager.run(id);
      } catch {
        throw new RunError("not_found", `this session has no terminal ${id}`);
      }
      if (run.sessionId !== sessionId) throw new RunError("not_found", `this session has no terminal ${id}`);
      return run;
    }
    const terminals = manager.terminals(sessionId);
    const open = terminals.filter((run) => !isTerminal(run.status));
    if (open.length === 1) return open[0]!;
    if (open.length > 1) {
      throw new RunError(
        "invalid_request",
        `this session has ${open.length} open terminals — ${open.map((run) => `"${run.title}" (${run.terminalId})`).join(", ")} — so say which one`,
        { terminals: open.map((run) => ({ terminalId: run.terminalId, title: run.title })) },
      );
    }
    const latest = mode === "read" ? terminals[0] : undefined;
    if (!latest) throw new RunError("not_found", "this session has no open terminal");
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
      return { terminals: manager.terminals(context.sessionId), sessionWorktreePath: context.worktreePath };
    },

    // `replace` is read and dropped: every start opens a new terminal.
    async start({ configId }) {
      const context = deps.context();
      return await manager.start({
        projectId: context.projectId,
        sessionId: context.sessionId,
        config: store.get(context.projectId, configId),
        worktreePath: context.worktreePath,
        ...(context.worktreeBranch ? { worktreeBranch: context.worktreeBranch } : {}),
      });
    },

    async stop(input) {
      return await manager.close(target(input, "act").terminalId, input?.closedBy ?? "person", input?.signal);
    },

    async restart(input) {
      // A restart may reopen one that already ended — that is a re-run, and
      // naming the ended one is how a caller asks for it.
      const run = target(input, input?.terminalId ?? input?.runId ? "read" : "act");
      return await manager.restart(run.terminalId, input?.closedBy ?? "person");
    },

    async output(input) {
      return manager.output(target(input, "read").terminalId, input?.after ?? 0, {
        ...(input?.tail === undefined ? {} : { tail: input.tail }),
        ...(input?.grep === undefined ? {} : { grep: input.grep }),
        ...(input?.stream === undefined ? {} : { stream: input.stream }),
      });
    },

    // `act` LIKE THE KEYBOARD AND UNLIKE `output`: waiting on "whatever ran
    // last" is waiting on nothing.
    async wait(input) {
      return await manager.wait(target(input, "act").terminalId, {
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
        ...(input.ready === undefined ? {} : { ready: input.ready }),
        ...(input.exit === undefined ? {} : { exit: input.exit }),
        timeoutMs: input.timeoutMs,
      });
    },

    async bytes(input) {
      return manager.bytes(target(input, "read").terminalId, input?.after ?? 0);
    },

    async write(input) {
      return { delivered: await manager.write(target(input, "act").terminalId, input.data) };
    },

    async resize(input) {
      return { resized: await manager.resize(target(input, "act").terminalId, input.cols, input.rows) };
    },
  };
}
