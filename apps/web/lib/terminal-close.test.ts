/**
 * CLOSE = KILL, AND WHEN TO ASK FIRST.
 *
 * The rule under test: a close asks only when something is running, in plain
 * words that name the command and how many processes it would end; an idle
 * terminal closes without a word; a question nobody could answer counts as
 * busy. And closing the whole Terminal tab ends every terminal in it — runs
 * included, through the engine — behind ONE question.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { TerminalActivity, TerminalBridge } from "@/lib/terminal-bridge";
import { closeTerminalTab, decideClose, endTerminal, mayClose } from "@/lib/terminal-close";
import {
  addShell,
  emptyWorkspace,
  nextShellId,
  setShellTerminal,
  upsertRunShell,
  workspaceParams,
  TERMINAL_ID_PARAM,
  TERMINAL_WORKSPACE_PARAM,
} from "@/lib/terminal-workspace";

const idle = (id: string): TerminalActivity => ({ id, active: false, processes: 0 });
const busy = (id: string, processes: number, command?: string): TerminalActivity => ({
  id,
  active: true,
  processes,
  ...(command ? { command } : {}),
});

describe("decideClose", () => {
  test("an idle terminal closes without asking", () => {
    expect(decideClose([{ id: "t1", label: "Shell 1" }], [idle("t1")])).toEqual({ action: "close" });
  });

  test("a busy one asks, naming the command and how many processes it ends", () => {
    const decision = decideClose([{ id: "t1", label: "web dev", command: "bun run dev" }], [busy("t1", 4, "node next dev")]);
    expect(decision.action).toBe("confirm");
    if (decision.action !== "confirm") return;
    // What the person launched, not what it became in the process table.
    expect(decision.message.split("\n")[0]).toBe("End “bun run dev” (4 processes)?");
    expect(decision.message).toContain("web dev");
  });

  test("a shell's command comes from the host, and one process is singular", () => {
    const decision = decideClose([{ id: "t1", label: "Shell 1" }], [busy("t1", 1, "vim notes.md")]);
    expect(decision.action === "confirm" && decision.message.split("\n")[0]).toBe("End “vim notes.md” (1 process)?");
  });

  test("no count is invented when the host could not count", () => {
    const decision = decideClose([{ id: "t1", label: "Shell 1" }], [busy("t1", 0)]);
    expect(decision.action === "confirm" && decision.message.split("\n")[0]).toBe("End what is running in Shell 1?");
  });

  test("a terminal the host no longer holds has already ended, and is not asked about", () => {
    expect(decideClose([{ id: "t1", label: "web dev" }], [])).toEqual({ action: "close" });
  });

  test("an unanswered question counts as busy — a missing prompt costs somebody's server", () => {
    const decision = decideClose([{ id: "t1", label: "web dev", command: "bun run dev" }], undefined);
    expect(decision.action === "confirm" && decision.message.split("\n")[0]).toBe("End “bun run dev”?");
  });

  test("a long command is clipped to one line", () => {
    const decision = decideClose([{ id: "t1", label: "x", command: `bun ${"a".repeat(200)}` }], [busy("t1", 2)]);
    const first = decision.action === "confirm" ? decision.message.split("\n")[0]! : "";
    expect(first.length).toBeLessThan(110);
    expect(first).toContain("…");
  });

  test("the whole tab asks once, listing only what is busy", () => {
    const decision = decideClose(
      [
        { id: "t1", label: "Shell 1" },
        { id: "t2", label: "web dev", command: "bun run dev" },
        { id: "t3", label: "api", command: "bun run api" },
      ],
      [idle("t1"), busy("t2", 4), busy("t3", 2)],
      "tab",
    );
    expect(decision.action).toBe("confirm");
    if (decision.action !== "confirm") return;
    expect(decision.message.split("\n")[0]).toBe("End 2 commands still running in this Terminal?");
    expect(decision.message).toContain("• “bun run dev” (4 processes)");
    expect(decision.message).toContain("• “bun run api” (2 processes)");
    expect(decision.message).not.toContain("Shell 1");
  });

  test("the copy names no product", () => {
    const decision = decideClose([{ id: "t1", label: "Shell 1" }], [busy("t1", 3, "vim")], "tab");
    for (const name of ["Electron", "xterm", "node-pty", "Claude"]) {
      expect(decision.action === "confirm" && decision.message).not.toContain(name);
    }
  });
});

/** A host that answers `active` from a table and records every close. */
function fakeBridge(table: TerminalActivity[], extra: Partial<TerminalBridge> = {}) {
  const asked: string[][] = [];
  const closed: string[] = [];
  const killed: string[] = [];
  const bridge = {
    active: async (ids?: string[]) => {
      asked.push(ids ?? []);
      return { terminals: table.filter((entry) => !ids || ids.includes(entry.id)) };
    },
    close: async (id: string) => {
      closed.push(id);
      return { ok: true };
    },
    kill: async (id: string) => {
      killed.push(id);
      return { ok: true };
    },
    ...extra,
  } as unknown as TerminalBridge;
  return { bridge, asked, closed, killed };
}

describe("mayClose", () => {
  test("asks the host about exactly these terminals, and nobody else when idle", async () => {
    const { bridge, asked } = fakeBridge([idle("t1")]);
    let prompted = 0;
    expect(await mayClose([{ id: "t1", label: "Shell 1" }], { bridge, confirm: () => (prompted += 1) > 0 })).toBe(true);
    expect(asked).toEqual([["t1"]]);
    expect(prompted).toBe(0);
  });

  test("a busy terminal closes only if the person says yes", async () => {
    const { bridge } = fakeBridge([busy("t1", 2, "bun run dev")]);
    const said: string[] = [];
    expect(await mayClose([{ id: "t1", label: "web dev" }], { bridge, confirm: (message) => (said.push(message), false) })).toBe(false);
    expect(said[0]).toStartWith("End “bun run dev” (2 processes)?");
    expect(await mayClose([{ id: "t1", label: "web dev" }], { bridge, confirm: () => true })).toBe(true);
  });

  test("a host that cannot answer is treated as busy", async () => {
    const { bridge } = fakeBridge([], { active: async () => Promise.reject(new Error("no ps")) });
    let prompted = 0;
    await mayClose([{ id: "t1", label: "web dev" }], { bridge, confirm: () => ((prompted += 1), true) });
    expect(prompted).toBe(1);
  });

  test("a session on another Mac (no bridge) asks, since nothing here can look", async () => {
    let prompted = 0;
    await mayClose([{ id: "t1", label: "web dev" }], { bridge: undefined, confirm: () => ((prompted += 1), true) });
    expect(prompted).toBe(1);
  });

  test("a desktop build older than the question closes without asking, as it always did", async () => {
    const { bridge } = fakeBridge([], { active: undefined });
    let prompted = 0;
    expect(await mayClose([{ id: "t1", label: "Shell 1" }], { bridge, confirm: () => ((prompted += 1), false) })).toBe(true);
    expect(prompted).toBe(0);
  });
});

describe("endTerminal", () => {
  test("a shell is closed by the host; a run by the engine, as the person", async () => {
    const { bridge, closed } = fakeBridge([]);
    const stopped: string[] = [];
    await endTerminal({ terminalId: "t1" }, { bridge, stopRun: async (id) => stopped.push(id) });
    await endTerminal({ terminalId: "run_1", run: true }, { bridge, stopRun: async (id) => stopped.push(id) });
    expect(closed).toEqual(["t1"]);
    expect(stopped).toEqual(["run_1"]);
  });

  test("a preload without `close` falls back to its kill", async () => {
    const { bridge, killed } = fakeBridge([], { close: undefined });
    await endTerminal({ terminalId: "t1" }, { bridge });
    expect(killed).toEqual(["t1"]);
  });

  test("a close that races the exit is not an error", async () => {
    const { bridge } = fakeBridge([], { close: async () => Promise.reject(new Error("gone")) });
    await endTerminal({ terminalId: "t1" }, { bridge });
    await endTerminal({ terminalId: "r1", run: true }, { bridge, stopRun: async () => Promise.reject(new Error("not_found")) });
  });
});

describe("closeTerminalTab", () => {
  /** A tab carrying shells, each attached to its own PTY, plus optional runs. */
  function tab(shells: string[], runs: Array<{ runId: string; open: boolean }> = []): Record<string, string> {
    let state = emptyWorkspace();
    for (const terminal of shells) {
      const id = nextShellId(state);
      state = setShellTerminal(addShell(state, id), id, terminal);
    }
    for (const run of runs) {
      state = upsertRunShell(state, { runId: run.runId, configId: "cfg", title: run.runId, ...(run.open ? { terminalId: run.runId } : {}) });
    }
    return workspaceParams(state);
  }

  test("an idle tab closes every shell without asking", async () => {
    const { bridge, closed } = fakeBridge([idle("t1"), idle("t2"), idle("t3")]);
    const ok = await closeTerminalTab(tab(["t1", "t2", "t3"]), { bridge, confirm: () => false });
    expect(ok).toBe(true);
    expect(closed).toEqual(["t1", "t2", "t3"]);
  });

  /**
   * THE OLD EXCEPTION, REVERSED. A run's terminal used to be spared by a tab
   * close because a run belonged to the project. It belongs to the session's
   * Terminal now, so closing the tab ends it — through the engine.
   */
  test("runs in the tab are ended through the engine, shells through the host", async () => {
    const { bridge, closed } = fakeBridge([idle("t1"), idle("run_a")]);
    const stopped: string[] = [];
    const ok = await closeTerminalTab(tab(["t1"], [{ runId: "run_a", open: true }]), {
      bridge,
      stopRun: async (id) => stopped.push(id),
      confirm: () => false,
    });
    expect(ok).toBe(true);
    expect(closed).toEqual(["t1"]);
    expect(stopped).toEqual(["run_a"]);
  });

  test("a run that had already ended has nothing to end", async () => {
    const { bridge } = fakeBridge([]);
    const stopped: string[] = [];
    await closeTerminalTab(tab([], [{ runId: "run_old", open: false }]), { bridge, stopRun: async (id) => stopped.push(id) });
    expect(stopped).toEqual([]);
  });

  test("anything busy asks ONCE, and no keeps every terminal running", async () => {
    const { bridge, closed } = fakeBridge([busy("t1", 1, "vim"), busy("run_a", 4)]);
    const stopped: string[] = [];
    const prompts: string[] = [];
    const ok = await closeTerminalTab(tab(["t1"], [{ runId: "run_a", open: true }]), {
      bridge,
      stopRun: async (id) => stopped.push(id),
      confirm: (message) => (prompts.push(message), false),
    });
    expect(ok).toBe(false);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toStartWith("End 2 commands still running in this Terminal?");
    expect(closed).toEqual([]);
    expect(stopped).toEqual([]);
  });

  test("a tab written before the strip existed still has its one shell closed", async () => {
    const { bridge, closed } = fakeBridge([idle("term_old")]);
    await closeTerminalTab({ [TERMINAL_ID_PARAM]: "term_old" }, { bridge });
    expect(closed).toEqual(["term_old"]);
  });

  test("a tab that never attached to anything closes nothing and asks nothing", async () => {
    const { bridge, asked, closed } = fakeBridge([]);
    expect(await closeTerminalTab({}, { bridge })).toBe(true);
    expect(await closeTerminalTab({ [TERMINAL_WORKSPACE_PARAM]: "not json" }, { bridge })).toBe(true);
    expect(asked).toEqual([]);
    expect(closed).toEqual([]);
  });
});
