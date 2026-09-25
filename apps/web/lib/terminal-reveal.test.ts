/**
 * A TERMINAL THAT OPENS PUTS ITSELF IN THE PANEL — the item, never the panel.
 *
 * Every assertion here is one half of the owner's rule: the Terminal tab and
 * the terminal's chip EXIST, whatever the panel is doing, and nothing the
 * person chose — the active tab, the active chip, whether the panel shows —
 * moves because an agent or a Run press opened something.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { RunView } from "@/lib/run/types";
import type { PanelTabInstance, PanelTabState } from "@/lib/right-panel-tabs";
import { freshTerminals, revealTerminal, TERMINAL_PANEL_KIND } from "@/lib/terminal-reveal";
import { addShell, emptyWorkspace, readWorkspace, runShells, shellForRun, workspaceParams } from "@/lib/terminal-workspace";

const view = (over: Partial<RunView> = {}): RunView => ({
  terminalId: "term_1",
  runId: "term_1",
  projectId: "project_1",
  sessionId: "session_1",
  origin: "agent",
  title: "vite",
  configName: "vite",
  command: "bun run dev",
  worktreePath: "/fixtures/telar",
  cwd: "/fixtures/telar",
  status: "running",
  readiness: { kind: "pending" },
  startedAt: 200,
  env: [],
  ...over,
});

const diff: PanelTabInstance<string> = { id: "diff", kind: "diff", params: {} };
const terminalTab = (state: PanelTabState<string>) => state.tabs.find((tab) => tab.kind === TERMINAL_PANEL_KIND);
const workspaceOf = (state: PanelTabState<string>) => readWorkspace(terminalTab(state)?.params ?? {});

describe("revealTerminal", () => {
  test("an agent's terminal_open adds the Terminal tab without changing the active tab", () => {
    const state: PanelTabState<string> = { tabs: [diff], activeTab: "diff", open: true };
    const next = revealTerminal(state, view(), TERMINAL_PANEL_KIND);
    expect(next.tabs.map((tab) => tab.id)).toEqual(["diff", "terminal"]);
    expect(next.activeTab).toBe("diff");
    expect(next.open).toBe(true);
  });

  test("a new agent or run terminal adds the tab and moves neither the active tab nor `open`, in all four panel states", () => {
    const cases: PanelTabState<string>[] = [
      { tabs: [diff], activeTab: "diff", open: false }, // hidden, on another tab
      { tabs: [diff], activeTab: "diff", open: true }, // showing another tab
      { tabs: [], open: true }, // showing the empty chooser
      { tabs: [], open: false }, // hidden and empty
    ];
    for (const origin of ["agent", "run"] as const) {
      for (const state of cases) {
        const next = revealTerminal(state, view({ origin, configId: origin === "run" ? "cfg_web" : undefined }), TERMINAL_PANEL_KIND);
        expect(next.tabs.map((tab) => tab.id)).toEqual([...state.tabs.map((tab) => tab.id), "terminal"]);
        expect(next.activeTab).toBe(state.activeTab);
        expect(next.open).toBe(state.open);
        // The chip exists in the tab's own workspace even though no surface is
        // mounted to have put it there.
        expect(shellForRun(workspaceOf(next), "term_1")?.terminalId).toBe("term_1");
      }
    }
  });

  test("the chip joins an existing strip without becoming the active chip", () => {
    const shells = addShell(addShell(emptyWorkspace()));
    const state: PanelTabState<string> = {
      tabs: [diff, { id: "terminal", kind: "terminal", params: workspaceParams(shells) }],
      activeTab: "terminal",
      open: true,
    };
    const next = revealTerminal(state, view({ origin: "run", configId: "cfg_web", title: "web dev" }), TERMINAL_PANEL_KIND);
    const workspace = workspaceOf(next);
    expect(workspace.shells.map((shell) => shell.id)).toEqual(["shell", "shell#2", "run"]);
    expect(workspace.active).toBe("shell#2");
    expect(runShells(workspace)[0]?.run).toEqual({ runId: "term_1", configId: "cfg_web" });
    // One Terminal tab, not a second one per terminal.
    expect(next.tabs.map((tab) => tab.id)).toEqual(["diff", "terminal"]);
    expect(next.activeTab).toBe("terminal");
  });

  test("a strip with no chip at all takes the new one as its active chip — the tab stays unselected", () => {
    const next = revealTerminal({ tabs: [diff], activeTab: "diff", open: false }, view(), TERMINAL_PANEL_KIND);
    expect(workspaceOf(next).active).toBe("run");
    expect(next.activeTab).toBe("diff");
  });

  test("a terminal already in the strip is the same state, so nothing is rewritten", () => {
    const once = revealTerminal({ tabs: [diff], activeTab: "diff", open: false }, view(), TERMINAL_PANEL_KIND);
    expect(revealTerminal(once, view(), TERMINAL_PANEL_KIND)).toBe(once);
  });

  test("a second terminal gets its own chip in the same tab", () => {
    const once = revealTerminal({ tabs: [], open: false }, view(), TERMINAL_PANEL_KIND);
    const twice = revealTerminal(once, view({ terminalId: "term_2", runId: "term_2", title: "vite #2", startedAt: 300 }), TERMINAL_PANEL_KIND);
    expect(workspaceOf(twice).shells.map((shell) => shell.title)).toEqual(["vite", "vite #2"]);
    expect(workspaceOf(twice).active).toBe("run");
    expect(twice.tabs.length).toBe(1);
  });
});

describe("freshTerminals", () => {
  const mountedAt = 150;

  test("terminals from before the mount are not news, so a reload does not re-add a closed tab", () => {
    // The feed's first act is reading /run/status, which lists everything the
    // session already had. The person closed the Terminal tab before reloading.
    const closed: PanelTabState<string> = { tabs: [diff], activeTab: "diff", open: true };
    const replayed = [view({ terminalId: "old", runId: "old", startedAt: 100 })];
    const fresh = freshTerminals(replayed, mountedAt, new Set());
    expect(fresh).toEqual([]);
    expect(fresh.reduce((state, run) => revealTerminal(state, run, TERMINAL_PANEL_KIND), closed)).toBe(closed);
  });

  test("one opened after the mount counts once, and its later frames do not bring back a closed chip", () => {
    const opened = view({ startedAt: 200 });
    expect(freshTerminals([opened], mountedAt, new Set()).map((run) => run.terminalId)).toEqual(["term_1"]);
    // The frame that reports the person closing it arrives after it was seen.
    expect(freshTerminals([{ ...opened, status: "closed", closedBy: "person" }], mountedAt, new Set(["term_1"]))).toEqual([]);
  });

  test("only open terminals count, oldest first", () => {
    const answer = [
      view({ terminalId: "b", runId: "b", startedAt: 300 }),
      view({ terminalId: "gone", runId: "gone", startedAt: 250, status: "closed", closedBy: "person" }),
      view({ terminalId: "a", runId: "a", startedAt: 200, status: "ready" }),
    ];
    expect(freshTerminals(answer, mountedAt, new Set()).map((run) => run.terminalId)).toEqual(["a", "b"]);
  });
});
