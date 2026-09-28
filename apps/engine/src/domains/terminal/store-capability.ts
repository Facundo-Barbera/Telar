import { type RunStatusAnswer, type RunView } from "@telar/engine-client";
import type { RunCapability, RunTarget } from "./capability";
import type { RunManager } from "./manager";
import type { RunStore } from "./store";
import { isTerminal, redactConfiguration, RunConfigurationInput, RunError } from "./types";

export type RunSessionContext = {
  sessionId: string;
  projectId: string;
  worktreePath: string;
  worktreeBranch?: string;
};

export type RunDeps = {
  store: RunStore;
  manager: RunManager;
  context: () => RunSessionContext;
};

function titleOf(command: string): string {
  const words = command.trim().split(/\s+/).slice(0, 3).join(" ");
  return words.length > 40 ? `${words.slice(0, 39)}…` : words;
}

export function storeRunCapability(deps: RunDeps): RunCapability {
  const { store, manager } = deps;

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

    async start({ configId, openedBy }) {
      const context = deps.context();
      return await manager.start({
        projectId: context.projectId,
        sessionId: context.sessionId,
        config: store.get(context.projectId, configId),
        worktreePath: context.worktreePath,
        ...(context.worktreeBranch ? { worktreeBranch: context.worktreeBranch } : {}),
        ...(openedBy ? { openedBy } : {}),
      });
    },

    async open(input) {
      const context = deps.context();
      const parsed = RunConfigurationInput.safeParse({
        name: input.name ?? titleOf(input.command),
        command: input.command,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.readinessUrl ? { readinessUrl: input.readinessUrl } : {}),
      });
      if (!parsed.success) throw new RunError("invalid_request", parsed.error.issues[0]?.message ?? "that terminal cannot be opened as asked");
      const at = Date.now();
      return await manager.start({
        projectId: context.projectId,
        sessionId: context.sessionId,
        config: { ...parsed.data, id: "", projectId: context.projectId, createdAt: at, updatedAt: at },
        worktreePath: context.worktreePath,
        ...(context.worktreeBranch ? { worktreeBranch: context.worktreeBranch } : {}),
        origin: "agent",
        openedBy: "agent",
        ...(input.readyPattern ? { readyPattern: input.readyPattern } : {}),
      });
    },

    async stop(input) {
      return await manager.close(target(input, "act").terminalId, input?.closedBy ?? "person", input?.signal);
    },

    async restart(input) {
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
