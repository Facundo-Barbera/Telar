/**
 * THE STRIP OF SHELLS, as a model.
 *
 * What matters here is the bookkeeping the surface must not have to do: that
 * closing the shell you are using moves focus to its NEIGHBOUR rather than
 * across the strip, that a chip says `Shell N` for its place in the strip until
 * the shell says otherwise, and that the PTY ids survive both a remount and the
 * upgrade from one-shell-per-outer-tab.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  activateShell,
  activeShell,
  addShell,
  closeShell,
  emptyWorkspace,
  foldTerminalParams,
  moveShell,
  nextShellId,
  readWorkspace,
  runShells,
  setShellTerminal,
  setShellTitle,
  shellForRun,
  shellLabel,
  terminalIds,
  terminalIdsInParams,
  upsertRunShell,
  workspaceParams,
  TERMINAL_ID_PARAM,
  TERMINAL_WORKSPACE_PARAM,
  type TerminalWorkspace,
} from "./terminal-workspace";

const ids = (state: TerminalWorkspace) => state.shells.map((shell) => shell.id);

/** Three shells, each attached to a PTY — the ordinary case every assertion
 *  below is a variation on. */
function three(): TerminalWorkspace {
  let state = emptyWorkspace();
  for (const pty of ["term_a", "term_b", "term_c"]) {
    const id = nextShellId(state);
    state = setShellTerminal(addShell(state), id, pty);
  }
  return state;
}

describe("opening shells", () => {
  test("an empty workspace has no shells and nothing active", () => {
    expect(emptyWorkspace()).toEqual({ shells: [] });
    expect(activeShell(emptyWorkspace())).toBeUndefined();
  });

  test("a new shell lands at the end of the strip and takes focus", () => {
    const state = addShell(addShell(emptyWorkspace()));
    expect(ids(state)).toEqual(["shell", "shell#2"]);
    expect(state.active).toBe("shell#2");
    expect(activeShell(state)?.id).toBe("shell#2");
  });

  test("a freed id can be taken again, but never while its chip is open", () => {
    const state = closeShell(addShell(addShell(emptyWorkspace())), "shell");
    expect(nextShellId(state)).toBe("shell");
    expect(ids(addShell(state))).toEqual(["shell#2", "shell"]);
  });

  test("adding an id that is already open focuses it instead of duplicating it", () => {
    const state = addShell(addShell(emptyWorkspace()));
    const again = addShell(state, "shell");
    expect(ids(again)).toEqual(["shell", "shell#2"]);
    expect(again.active).toBe("shell");
  });

  test("activating a shell nobody has changes nothing", () => {
    const state = three();
    expect(activateShell(state, "shell#9")).toBe(state);
  });
});

describe("closing a shell", () => {
  test("closing the ACTIVE shell focuses its neighbour to the right", () => {
    const closed = closeShell(activateShell(three(), "shell#2"), "shell#2");
    expect(ids(closed)).toEqual(["shell", "shell#3"]);
    // The neighbour, not the first shell — the eye does not jump the strip.
    expect(closed.active).toBe("shell#3");
  });

  test("closing the RIGHTMOST active shell falls back to the new last one", () => {
    expect(closeShell(activateShell(three(), "shell#3"), "shell#3").active).toBe("shell#2");
  });

  test("closing an inactive shell does not steal focus", () => {
    expect(closeShell(activateShell(three(), "shell#3"), "shell").active).toBe("shell#3");
  });

  test("closing the last shell leaves an empty workspace with nothing active", () => {
    // The SURFACE decides an empty Terminal should close its outer tab; a
    // reducer that reseeded itself could never say so.
    expect(closeShell(addShell(emptyWorkspace()), "shell")).toEqual({ shells: [] });
  });

  test("closing a shell that is not open changes nothing", () => {
    const state = three();
    expect(closeShell(state, "shell#9")).toBe(state);
  });
});

describe("what a chip says", () => {
  test("titles fall back to Shell N, by place in the strip", () => {
    const state = three();
    expect(shellLabel(state, "shell")).toBe("Shell 1");
    expect(shellLabel(state, "shell#2")).toBe("Shell 2");
    expect(shellLabel(state, "shell#3")).toBe("Shell 3");
  });

  test("the number follows the strip rather than the id", () => {
    // After a close the ids read "shell, shell#3" — the labels must still read
    // "Shell 1, Shell 2", or the strip is a puzzle.
    const state = closeShell(three(), "shell#2");
    expect(state.shells.map((shell) => shellLabel(state, shell.id))).toEqual(["Shell 1", "Shell 2"]);
  });

  test("OSC 0/2 wins over the fallback, and clearing it gives the fallback back", () => {
    const titled = setShellTitle(three(), "shell#2", "~/code/telar");
    expect(shellLabel(titled, "shell#2")).toBe("~/code/telar");
    expect(shellLabel(setShellTitle(titled, "shell#2", "   "), "shell#2")).toBe("Shell 2");
  });

  test("an unchanged title is not a new state", () => {
    const titled = setShellTitle(three(), "shell", "nvim");
    expect(setShellTitle(titled, "shell", "nvim")).toBe(titled);
    expect(setShellTitle(titled, "nobody", "nvim")).toBe(titled);
  });

  test("a shell nobody has is labelled rather than crashing the strip", () => {
    expect(shellLabel(three(), "shell#9")).toBe("Shell");
  });
});

describe("remembering the PTY", () => {
  test("a shell remembers the terminal it attached to", () => {
    const state = setShellTerminal(addShell(emptyWorkspace()), "shell", "term_x");
    expect(state.shells[0]?.terminalId).toBe("term_x");
    expect(terminalIds(state)).toEqual(["term_x"]);
  });

  test("shells still waiting on a spawn contribute no id to kill", () => {
    expect(terminalIds(addShell(three()))).toEqual(["term_a", "term_b", "term_c"]);
  });

  test("setting the same terminal twice is not a new state", () => {
    const state = setShellTerminal(addShell(emptyWorkspace()), "shell", "term_x");
    expect(setShellTerminal(state, "shell", "term_x")).toBe(state);
    expect(setShellTerminal(state, "nobody", "term_x")).toBe(state);
  });

  test("a title does not lose the PTY beside it", () => {
    const state = setShellTitle(three(), "shell#2", "zsh");
    expect(state.shells[1]).toEqual({ id: "shell#2", terminalId: "term_b", title: "zsh" });
  });
});

describe("reordering", () => {
  test("a shell moves to an index in the RESULT, and focus does not move with it", () => {
    const moved = moveShell(activateShell(three(), "shell"), "shell#3", 0);
    expect(ids(moved)).toEqual(["shell#3", "shell", "shell#2"]);
    expect(moved.active).toBe("shell");
  });

  test("a drop past the end means last, and an unknown shell moves nothing", () => {
    expect(ids(moveShell(three(), "shell", 99))).toEqual(["shell#2", "shell#3", "shell"]);
    const state = three();
    expect(moveShell(state, "shell#9", 0)).toBe(state);
    expect(moveShell(state, "shell", 0)).toBe(state);
  });
});

describe("the tab's params", () => {
  test("a workspace round-trips through one JSON key", () => {
    const state = activateShell(setShellTitle(three(), "shell#2", "nvim"), "shell#3");
    const params = workspaceParams(state);
    expect(Object.keys(params)).toEqual([TERMINAL_WORKSPACE_PARAM]);
    expect(readWorkspace(params)).toEqual(state);
  });

  test("an empty workspace writes no key at all", () => {
    expect(workspaceParams(emptyWorkspace())).toEqual({});
    expect(readWorkspace({})).toEqual(emptyWorkspace());
  });

  test("a tab written by the old build is read as one shell on its PTY", () => {
    const state = readWorkspace({ [TERMINAL_ID_PARAM]: "term_old" });
    expect(state.shells).toEqual([{ id: "shell", terminalId: "term_old" }]);
    expect(state.active).toBe("shell");
    expect(terminalIdsInParams({ [TERMINAL_ID_PARAM]: "term_old" })).toEqual(["term_old"]);
  });

  test("junk in storage restores as an empty workspace rather than a broken strip", () => {
    for (const raw of ["not json", "[]", '{"shells":"nope"}', '{"shells":[]}', '{"shells":[{"id":42}]}']) {
      expect(readWorkspace({ [TERMINAL_WORKSPACE_PARAM]: raw })).toEqual(emptyWorkspace());
    }
  });

  test("an `active` naming nothing falls back to the first shell", () => {
    const raw = JSON.stringify({ shells: [{ id: "a" }, { id: "b" }], active: "gone" });
    expect(readWorkspace({ [TERMINAL_WORKSPACE_PARAM]: raw }).active).toBe("a");
  });

  test("the new key wins over a stale legacy one on the same tab", () => {
    const params = { ...workspaceParams(three()), [TERMINAL_ID_PARAM]: "term_old" };
    expect(terminalIdsInParams(params)).toEqual(["term_a", "term_b", "term_c"]);
  });
});

describe("folding several outer tabs into one", () => {
  test("every tab's shells arrive, in strip order, with ids that cannot collide", () => {
    const state = readWorkspace(
      foldTerminalParams([{ [TERMINAL_ID_PARAM]: "term_1" }, { [TERMINAL_ID_PARAM]: "term_2" }, { [TERMINAL_ID_PARAM]: "term_3" }]),
    );
    expect(terminalIds(state)).toEqual(["term_1", "term_2", "term_3"]);
    // All three old tabs called their shell `shell`; keeping that would have
    // collapsed three live shells into one chip.
    expect(ids(state)).toEqual(["shell", "shell#2", "shell#3"]);
    expect(state.active).toBe("shell");
  });

  test("a tab that already has a workspace folds in whole, titles and all", () => {
    const first = setShellTitle(addShell(addShell(emptyWorkspace())), "shell", "nvim");
    const folded = readWorkspace(foldTerminalParams([workspaceParams(first), { [TERMINAL_ID_PARAM]: "term_z" }]));
    expect(folded.shells.length).toBe(3);
    expect(folded.shells[0]?.title).toBe("nvim");
    expect(terminalIds(folded)).toEqual(["term_z"]);
  });

  test("folding nothing, or tabs that never attached, writes no key", () => {
    expect(foldTerminalParams([])).toEqual({});
    expect(foldTerminalParams([{}, {}])).toEqual({});
  });
});

/**
 * A RUN IS A CHIP IN THIS STRIP (#890), and every assertion here is about the
 * one way it differs from a shell: WHO OWNS THE PROCESS. A shell belongs to the
 * tab that opened it and dies with it; a run belongs to the project, outlives
 * the conversation that started it, and may be what another session is watching
 * right now.
 */
describe("a run in the strip", () => {
  const dev = { runId: "run_1", configId: "cfg_1", terminalId: "term_run", title: "web dev" };

  test("a run takes a chip of its own, without stealing focus", () => {
    // A run can start from an agent's tool call or another session's button, so
    // the strip must not jump to it under somebody's hands.
    const state = upsertRunShell(three(), dev);
    expect(ids(state)).toEqual(["shell", "shell#2", "shell#3", "run"]);
    // Whatever had focus keeps it — `three()` leaves the last shell opened.
    expect(state.active).toBe("shell#3");
    expect(shellForRun(state, "run_1")?.terminalId).toBe("term_run");
    expect(runShells(state).map((shell) => shell.id)).toEqual(["run"]);
  });

  test("pressing play yourself focuses the chip", () => {
    expect(upsertRunShell(three(), dev, { focus: true }).active).toBe("run");
  });

  test("the same run arriving twice is one chip, and an unchanged frame is not a new state", () => {
    // This is fed by a status stream and by the mount that adopts what is
    // already running, so the same run arrives repeatedly by construction.
    const once = upsertRunShell(three(), dev);
    expect(upsertRunShell(once, dev)).toBe(once);
    expect(runShells(upsertRunShell(once, dev)).length).toBe(1);
  });

  test("a terminal id that arrives late, and one that goes, are both written", () => {
    // `starting` has no PTY yet; a run whose handle is gone stops naming one.
    const starting = upsertRunShell(emptyWorkspace(), { runId: "run_1", configId: "cfg_1", title: "web dev" });
    expect(shellForRun(starting, "run_1")?.terminalId).toBeUndefined();
    const running = upsertRunShell(starting, dev);
    expect(shellForRun(running, "run_1")?.terminalId).toBe("term_run");
    const ended = upsertRunShell(running, { runId: "run_1", configId: "cfg_1", title: "web dev" });
    expect(shellForRun(ended, "run_1")?.terminalId).toBeUndefined();
  });

  test("CLOSING THE TERMINAL TAB DOES NOT REAP A RUN", () => {
    // The sharpest rule in the file: `terminalIds` is what the reaper kills, and
    // a run's id on it would stop somebody else's dev server because a person
    // here closed a tab.
    const state = upsertRunShell(three(), dev);
    expect(terminalIds(state)).toEqual(["term_a", "term_b", "term_c"]);
    expect(terminalIds(state)).not.toContain("term_run");
    // And through the params, which is the shape the reaper actually reads.
    expect(terminalIdsInParams(workspaceParams(state))).toEqual(["term_a", "term_b", "term_c"]);
  });

  test("a run's chip says its configuration's name, and does not renumber the shells", () => {
    const state = upsertRunShell(emptyWorkspace(), dev);
    const withShells = addShell(addShell(state));
    expect(shellLabel(withShells, "run")).toBe("web dev");
    // "Shell 2" must mean the second shell you can see, whatever else is in the
    // strip — the run chip sits first here and still does not take the number.
    expect(shellLabel(withShells, "shell")).toBe("Shell 1");
    expect(shellLabel(withShells, "shell#2")).toBe("Shell 2");
  });

  test("a run survives the params round trip, chip and all", () => {
    const state = upsertRunShell(three(), dev);
    const restored = readWorkspace(workspaceParams(state));
    expect(shellForRun(restored, "run_1")).toEqual({ id: "run", terminalId: "term_run", title: "web dev", run: { runId: "run_1", configId: "cfg_1" } });
  });

  test("a half-written run restores as an ordinary shell rather than an unaddressable chip", () => {
    // With no runId there is nothing to stop and no status to follow, so the
    // chip would draw for ever as a blank run nobody can act on.
    const raw = JSON.stringify({ shells: [{ id: "run", run: { configId: "cfg_1" } }, { id: "shell" }], active: "shell" });
    const restored = readWorkspace({ [TERMINAL_WORKSPACE_PARAM]: raw });
    expect(runShells(restored)).toEqual([]);
    expect(ids(restored)).toEqual(["run", "shell"]);
  });

  test("an agent's terminal, which came from no recipe, restores as a run and not as a shell", () => {
    // `terminal_open` with a command of its own has no configId. Read back as a
    // shell it would hold the engine's terminal id and get a second chip.
    const agent = { runId: "term_agent", configId: "", terminalId: "term_agent", title: "vite" };
    const restored = readWorkspace(workspaceParams(upsertRunShell(emptyWorkspace(), agent)));
    expect(shellForRun(restored, "term_agent")).toEqual({ id: "run", terminalId: "term_agent", title: "vite", run: { runId: "term_agent", configId: "" } });
    expect(terminalIds(restored)).toEqual([]);
  });

  test("a second run gets its own chip beside the first", () => {
    const state = upsertRunShell(upsertRunShell(emptyWorkspace(), dev), { runId: "run_2", configId: "cfg_2", title: "api" });
    expect(runShells(state).map((shell) => shell.id)).toEqual(["run", "run#2"]);
  });

  test("closing a run's chip removes it and leaves the others alone", () => {
    const state = closeShell(upsertRunShell(three(), dev), "run");
    expect(shellForRun(state, "run_1")).toBeUndefined();
    expect(ids(state)).toEqual(["shell", "shell#2", "shell#3"]);
  });
});
