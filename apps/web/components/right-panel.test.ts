/**
 * The panel's four surfaces are FOLDS over the session record, and the folds are
 * where the judgement lives. This used to assert the panel's prose — back when
 * the panel's whole content was a sentence explaining that it had none — which
 * pinned copy rather than behaviour and went stale the moment it gained tabs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Task } from "@telar/engine-client";
import {
  browserPanelTab,
  describeBrowserStart,
  describePanelTab,
  filePanelTabPath,
  isFilePanelTab,
  migratePanelTab,
  groupWarps,
  isLiveTask,
  isPanelTab,
  issuePanelNumber,
  issuePanelTab,
  journalWrites,
  latestBrowserState,
  openForgeNumbers,
  panelTabForPath,
  pdfPanelPath,
  pdfPanelTab,
  pullPanelNumber,
  pullPanelTab,
  splitRoster,
} from "./right-panel";

function fileChange(overrides: {
  path: string;
  at: number;
  status?: Item["status"];
  kind?: "create" | "edit" | "delete" | "rename";
  linesAdded?: number;
}): Item {
  return {
    id: `item_${overrides.path}_${overrides.at}`,
    sessionId: "session_1",
    runId: "run_1",
    status: overrides.status ?? "completed",
    startedAt: overrides.at,
    completedAt: overrides.at,
    detail: {
      type: "file_change",
      change: {
        path: overrides.path,
        kind: overrides.kind ?? "edit",
        ...(overrides.linesAdded === undefined ? {} : { linesAdded: overrides.linesAdded }),
      },
    },
  } as Item;
}

describe("journalWrites", () => {
  test("counts every write per path, whatever order they arrive in", () => {
    // The count is the one fact git cannot state: a file rewritten twice has the
    // same net diff as a file written once, and the Diff surface badges it `×2`.
    const writes = journalWrites([
      fileChange({ path: "a.ts", at: 200, linesAdded: 9 }),
      fileChange({ path: "a.ts", at: 100, linesAdded: 1 }),
      fileChange({ path: "b.ts", at: 150 }),
    ]);
    expect([...writes]).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });

  test("omits changes that never landed", () => {
    // Counting a declined or failed change would claim the session edited a file
    // it did not — and on the Diff surface that would move the row from "not in
    // the transcript" to "the session wrote this", which is the most damaging
    // kind of wrong this fold can be.
    expect(journalWrites([fileChange({ path: "a.ts", at: 1, status: "declined" })]).size).toBe(0);
    expect(journalWrites([fileChange({ path: "b.ts", at: 1, status: "failed" })]).size).toBe(0);
  });
});

describe("file tabs", () => {
  test("a bare `file:` is not a tab", () => {
    // It names nothing, so restoring it from localStorage would produce a tab
    // that can only ever fail to load.
    expect(isPanelTab("file:src/a.ts")).toBe(true);
    expect(isPanelTab("file:")).toBe(false);
    // And the renamed surfaces are what this build understands.
    expect(isPanelTab("diff")).toBe(true);
    expect(isPanelTab("changes")).toBe(false);
    expect(isPanelTab("git")).toBe(false);
    // Retired in favour of Editor (#193), so it is no longer a tab this build
    // will restore — `migratePanelTab` is what a saved one goes through.
    expect(isPanelTab("files")).toBe(false);
  });

  test("a saved Files tab opens on Editor rather than on nothing (#193)", () => {
    // Removing the CHOICE must not strand an arrangement that already made it.
    // Editor mounts the same tree component, so this lands where the reader was
    // going: the checkout, browsable, with files openable from it.
    expect(migratePanelTab("files")).toBe("editor");
    expect(isPanelTab(migratePanelTab("files"))).toBe(true);
  });
});

describe("the Run surface", () => {
  test("is a real tab: it validates, it survives a restore, and it is not file-shaped", () => {
    // The panel restores tab ids from storage, so a surface that does not
    // validate here is one that silently disappears on the next reload.
    expect(isPanelTab("run")).toBe(true);
    expect(migratePanelTab("run")).toBe("run");
    // Not file-shaped: it must not be collapsed into the Editor.
    expect(isFilePanelTab("run")).toBe(false);
  });

  test("describes itself without needing the network or a session", () => {
    // A restored tab has to be drawable before anything is fetched — the run
    // status is a poll, and a tab that could not label itself until it answered
    // would render blank on every cold open.
    const { label, blurb } = describePanelTab("run");
    expect(label).toBe("Run");
    expect(blurb.length).toBeGreaterThan(0);
  });
});

describe("pdf tabs", () => {
  test("a .pdf path routes to its own tab, data science or not", () => {
    // The PDF viewer is deliberately ungated: compiled LaTeX output, a
    // downloaded paper — a document renders wherever it is opened from.
    expect(panelTabForPath("docs/paper.pdf", false)).toBe("pdf:docs/paper.pdf");
    expect(panelTabForPath("docs/paper.pdf", true)).toBe("pdf:docs/paper.pdf");
    // While the data-science pair keeps its gate.
    expect(panelTabForPath("analysis.ipynb", false)).toBe("file:analysis.ipynb");
    expect(panelTabForPath("analysis.ipynb", true)).toBe("notebook:analysis.ipynb");
    // And markdown stays a `file:` tab — the file view renders it itself.
    expect(panelTabForPath("README.md", false)).toBe("file:README.md");
  });

  test("the tab round-trips, validates, and counts as an open file", () => {
    expect(pdfPanelPath(pdfPanelTab("a/b.pdf"))).toBe("a/b.pdf");
    expect(isPanelTab("pdf:docs/paper.pdf")).toBe(true);
    expect(isPanelTab("pdf:")).toBe(false);
    expect(describePanelTab("pdf:docs/paper.pdf").label).toBe("paper.pdf");
  });
});

describe("files are the Editor's, not the strip's", () => {
  test("every file-shaped id names a path, and a bare prefix names nothing", () => {
    // These ids are still the vocabulary every "open this file" gesture speaks
    // — a chip, the display tool, a compiled PDF — and the cockpit reads the
    // path back out of them instead of minting a tab.
    expect(filePanelTabPath("file:src/a.ts")).toBe("src/a.ts");
    expect(filePanelTabPath("notebook:nb.ipynb")).toBe("nb.ipynb");
    expect(filePanelTabPath("table:d.csv")).toBe("d.csv");
    expect(filePanelTabPath("pdf:docs/paper.pdf")).toBe("docs/paper.pdf");
    // First separator only: a colon is legal in a filename.
    expect(filePanelTabPath("file:src/weird:name.ts")).toBe("src/weird:name.ts");
    expect(filePanelTabPath("file:")).toBeUndefined();
    expect(filePanelTabPath("files")).toBeUndefined();
    expect(filePanelTabPath("diff")).toBeUndefined();
    expect(isFilePanelTab("browser:p1")).toBe(false);
  });

  test("a panel saved with four open files restores as ONE Editor tab", () => {
    // The defect this closes: four files pushed Diff and Issues off the end of
    // the strip. They collapse to one id here, and `readPanelTabs` dedupes it —
    // the files themselves are restored INTO the Editor by
    // `editorFromLegacyTabs`, which reads the same stored ids first.
    const stored = ["diff", "file:a.ts", "notebook:b.ipynb", "issues", "pdf:c.pdf", "table:d.csv"];
    expect(stored.map(migratePanelTab)).toEqual(["diff", "editor", "editor", "issues", "editor", "editor"]);
    // And the surfaces it already migrated keep migrating.
    expect(migratePanelTab("plots")).toBe("data");
    expect(migratePanelTab("diff")).toBe("diff");
    expect(isPanelTab("editor")).toBe(true);
  });
});

describe("issue and pull-request tabs", () => {
  test("a tab id round-trips to the number the surface will ask gh for", () => {
    expect(issuePanelNumber(issuePanelTab(82))).toBe(82);
    expect(pullPanelNumber(pullPanelTab(12))).toBe(12);
    // And the two do not answer for each other: `issue:82` and `pull:82` are
    // different things with the same number, which is the common case.
    expect(pullPanelNumber(issuePanelTab(82))).toBeUndefined();
    expect(issuePanelNumber(pullPanelTab(12))).toBeUndefined();
    expect(issuePanelNumber("editor")).toBeUndefined();
  });

  test("only DIGITS are a number", () => {
    // Restoring `issue:12abc` from localStorage would open a surface that can only
    // ask gh a question with no answer.
    expect(isPanelTab("issue:82")).toBe(true);
    expect(isPanelTab("pull:1")).toBe(true);
    expect(isPanelTab("issue:")).toBe(false);
    expect(isPanelTab("issue:12abc")).toBe(false);
    expect(isPanelTab("issue:-4")).toBe(false);
    expect(isPanelTab("issue:0")).toBe(false);
    expect(isPanelTab("pull:1.5")).toBe(false);
  });

  test("the open set is read per kind, so a list marks its own rows only", () => {
    // An issue #12 open as a tab must not put the "already open" mark on pull
    // request #12 in the other list.
    const tabs = ["issues", "issue:82", "issue:9", "pull:12", "file:a.ts"] as const;
    expect(openForgeNumbers(tabs, "issue")).toEqual([82, 9]);
    expect(openForgeNumbers(tabs, "pull")).toEqual([12]);
  });
});

describe("the retired Usage surface", () => {
  test("a stored 'usage' tab id restores as nothing", () => {
    // The surface was removed; a panel persisted before the removal may still
    // hold its id. The validator refusing it is what makes the restore drop the
    // tab instead of rendering a blank pane.
    expect(isPanelTab("usage")).toBe(false);
    expect(isPanelTab("agents")).toBe(true);
  });
});

describe("latestBrowserState", () => {
  test("replaces rather than merges, because the event carries the whole tab set", () => {
    const events = [
      { type: "browser.state.changed", provider: "headless", tabs: [{ id: "1" }, { id: "2" }] },
      { type: "browser.state.changed", provider: "headless", tabs: [{ id: "3" }] },
    ] as unknown as EngineEvent[];
    expect(latestBrowserState(events)?.tabs.map((tab) => tab.id)).toEqual(["3"]);
  });

  test("is undefined when the session has never browsed", () => {
    expect(latestBrowserState([])).toBeUndefined();
  });
});

describe("isLiveTask", () => {
  test("counts waiting as live — a blocked sub-agent has not finished", () => {
    for (const state of ["pending", "running", "waiting"]) {
      expect(isLiveTask({ state } as Task)).toBe(true);
    }
    for (const state of ["completed", "failed", "stopped"]) {
      expect(isLiveTask({ state } as Task)).toBe(false);
    }
  });
});

describe("groupWarps", () => {
  /**
   * THE FOLD THAT REPLACES A SECOND RAIL. The frozen cockpit needed a whole
   * separate surface for an Ultra run because the legacy harness kept runs in
   * its own storage; here a run and its agents are rows on the one task stream,
   * so the progress tree is a grouping and cannot disagree with the roster.
   */
  const agent = (id: string, warp: Record<string, unknown>, state = "completed"): unknown => ({
    id,
    kind: "agent",
    state,
    title: id,
    warp,
    items: [],
  });
  const runRow = (id: string, name: string, state = "running"): unknown => ({
    id,
    kind: "background",
    state,
    title: name,
    warp: { warpRunId: id, warpName: name },
    items: [],
  });

  test("a run is identified by its own self-pointing linkage, not by its children", () => {
    // Which is what keeps a run identifiable once its agents have aged out of
    // retention — the same failure the contract forbids for agents.
    const { groups } = groupWarps([runRow("warp_1", "review")] as never);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("review");
    expect(groups[0]!.run?.id).toBe("warp_1");
    expect(groups[0]!.phases).toHaveLength(0);
  });

  test("agents are grouped under their run and ordered as the script asked", () => {
    const { groups, loose } = groupWarps([
      runRow("warp_1", "review"),
      agent("b", { warpRunId: "warp_1", warpName: "review", phaseIndex: 0, phaseTitle: "Find", agentIndex: 1 }),
      agent("a", { warpRunId: "warp_1", warpName: "review", phaseIndex: 0, phaseTitle: "Find", agentIndex: 0 }),
    ] as never);
    expect(loose).toHaveLength(0);
    expect(groups[0]!.phases[0]!.agents.map((task) => task.id)).toEqual(["a", "b"]);
  });

  test("declared phases sort by position; an improvised one sorts after", () => {
    // A script may open a phase its `meta` never declared, and those rows carry
    // a title with no index at all.
    const { groups } = groupWarps([
      agent("late", { warpRunId: "w", warpName: "n", phaseTitle: "Improvised" }),
      agent("second", { warpRunId: "w", warpName: "n", phaseIndex: 1, phaseTitle: "Verify" }),
      agent("first", { warpRunId: "w", warpName: "n", phaseIndex: 0, phaseTitle: "Find" }),
    ] as never);
    expect(groups[0]!.phases.map((phase) => phase.title)).toEqual(["Find", "Verify", "Improvised"]);
  });

  test("phases are keyed by title, so two improvised ones do not merge", () => {
    // Keying on the index would collapse every index-less phase into one bucket.
    const { groups } = groupWarps([
      agent("x", { warpRunId: "w", warpName: "n", phaseTitle: "Alpha" }),
      agent("y", { warpRunId: "w", warpName: "n", phaseTitle: "Beta" }),
    ] as never);
    expect(groups[0]!.phases.map((phase) => phase.title)).toEqual(["Alpha", "Beta"]);
  });

  test("a script that opened no phase has one unlabelled bucket", () => {
    const { groups } = groupWarps([agent("x", { warpRunId: "w", warpName: "n" })] as never);
    expect(groups[0]!.phases).toHaveLength(1);
    expect(groups[0]!.phases[0]!.title).toBeUndefined();
  });

  test("two concurrent runs of one script do not merge", () => {
    // Distinct runIds are exactly why the linkage carries one alongside the
    // name — the name is the script, the id is this run of it.
    const { groups } = groupWarps([
      agent("x", { warpRunId: "w1", warpName: "review" }),
      agent("y", { warpRunId: "w2", warpName: "review" }),
    ] as never);
    expect(groups).toHaveLength(2);
  });

  test("the kind split happens AFTER the warp fold, so a run keeps its agents", () => {
    // A Warp run's own row is a `background` task whose children are agents.
    // Splitting on kind first would file the run under Processes and orphan its
    // agents on the Agents surface as a headless group.
    const split = splitRoster([
      runRow("warp_1", "review"),
      agent("child", { warpRunId: "warp_1", warpName: "review", phaseIndex: 0, phaseTitle: "Find", agentIndex: 0 }),
      { id: "shell", kind: "background", state: "running", items: [] },
      { id: "plain", kind: "agent", state: "running", items: [] },
    ] as never);
    expect(split.groups).toHaveLength(1);
    expect(split.groups[0]!.run?.id).toBe("warp_1");
    expect(split.agents.map((task) => task.id)).toEqual(["plain"]);
    expect(split.processes.map((task) => task.id)).toEqual(["shell"]);
  });

  test("a task with no kind at all is presumed an agent, matching the contract's denylist", () => {
    const split = splitRoster([{ id: "unkinded", state: "running", items: [] }] as never);
    expect(split.agents).toHaveLength(1);
    expect(split.processes).toHaveLength(0);
  });

  test("an ordinary sub-agent carries no linkage and stays loose", () => {
    // The whole point of the linkage being optional as a block: nothing has to
    // know about warps to render a plain sub-agent.
    const { groups, loose } = groupWarps([
      { id: "plain", kind: "agent", state: "running", items: [] },
      runRow("warp_1", "review"),
    ] as never);
    expect(loose.map((task) => task.id)).toEqual(["plain"]);
    expect(groups).toHaveLength(1);
  });
});

describe("describeBrowserStart", () => {
  test("a tab means the press worked and the button goes quiet", () => {
    expect(describeBrowserStart({ running: true, tabs: [{ id: "0", url: "about:blank", title: "", active: true }] })).toEqual({ status: "idle" });
  });

  test("the engine's error is the message, verbatim", () => {
    expect(describeBrowserStart({ running: true, tabs: [], error: "Tab limit reached." })).toEqual({ status: "error", message: "Tab limit reached." });
  });

  test("running with no tab is named, not left looking like 'still starting'", () => {
    expect(describeBrowserStart({ running: true, tabs: [] })).toEqual({ status: "error", message: "The browser started but opened no page." });
    expect(describeBrowserStart({ running: false, tabs: [] })).toEqual({ status: "error", message: "The browser did not start." });
  });
});

describe("a browser tab's label comes from the live page when the shell has one", () => {
  const journal = { provider: "engine" as never, tabs: [{ id: "p1", title: "Old title", url: "https://old.example", active: true }] } as never;

  test("the journal alone names the page, and a missing page says so", () => {
    expect(describePanelTab(browserPanelTab("p1"), journal).label).toBe("Old title");
    expect(describePanelTab(browserPanelTab("gone"), journal)).toMatchObject({ label: "Closed page", missing: true });
  });

  test("a live tab with the same id wins over the journal", () => {
    const live = [{ id: "p1", title: "Example Domain", url: "https://example.com", active: true }];
    expect(describePanelTab(browserPanelTab("p1"), journal, live)).toMatchObject({ label: "Example Domain", blurb: "https://example.com" });
  });

  test("a journal id the shell never saw takes the shell's ACTIVE tab, not 'Closed page'", () => {
    const live = [
      { id: "native-a", title: "Background", url: "https://a.example", active: false },
      { id: "native-b", title: "Example Domain", url: "https://example.com", active: true },
    ];
    const described = describePanelTab(browserPanelTab("gone"), journal, live);
    expect(described.label).toBe("Example Domain");
    expect(described.missing).toBeUndefined();
  });

  test("no live tabs at all falls back to the journal's answer", () => {
    expect(describePanelTab(browserPanelTab("gone"), journal, [])).toMatchObject({ label: "Closed page", missing: true });
  });
});
