/**
 * The panel's four surfaces are FOLDS over the session record, and the folds are
 * where the judgement lives. This used to assert the panel's prose — back when
 * the panel's whole content was a sentence explaining that it had none — which
 * pinned copy rather than behaviour and went stale the moment it gained tabs.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineEvent, Item, Task } from "@telar/engine-client";
import {
  browserPanelTab,
  describeBrowserStart,
  describePanelTab,
  filePanelTabPath,
  isFilePanelTab,
  migratePanelTab,
  isLiveTask,
  isMultiInstancePanelTab,
  isPanelTab,
  issuePanelNumber,
  issuePanelTab,
  journalWrites,
  latestBrowserState,
  panelTabForPath,
  pdfPanelPath,
  pdfPanelTab,
  pullPanelNumber,
  pullPanelTab,
  splitRoster,
  type PanelTab,
} from "./right-panel";
import { emptyPanelTabs, openNewPanelTab, openPanelTab } from "@/lib/right-panel-tabs";

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

describe("the Terminal surface", () => {
  test("is a real tab: it validates, it survives a restore, and it is not file-shaped", () => {
    // The panel restores tab ids from storage, so a surface that does not
    // validate here is one that silently disappears on the next reload — and
    // with it the id of a shell that is still running.
    expect(isPanelTab("terminal")).toBe(true);
    expect(migratePanelTab("terminal")).toBe("terminal");
    expect(isFilePanelTab("terminal")).toBe(false);
  });

  test("describes itself with no session and no shell", () => {
    const { label, blurb } = describePanelTab("terminal");
    expect(label).toBe("Terminal");
    expect(blurb.length).toBeGreaterThan(0);
  });

  test("is multi-instance — a second terminal is a second shell", () => {
    // And the three folds beside it are not, which is what makes this a
    // statement about terminals rather than about the set's length.
    expect(isMultiInstancePanelTab("terminal")).toBe(true);
    expect(isMultiInstancePanelTab("run")).toBe(false);
    expect(isMultiInstancePanelTab("processes")).toBe(false);
  });

  test("a second instance takes its own id, so its PTY cannot be the first's", () => {
    // `nextPanelTabId` is what mints it, and the params keyed on that id are
    // where each tab's terminal id is kept. Two tabs sharing an id would be two
    // surfaces reading one shell's bytes.
    let state = openPanelTab(emptyPanelTabs<PanelTab>(), "terminal");
    state = openNewPanelTab(state, "terminal");
    expect(state.tabs.map((entry) => entry.id)).toEqual(["terminal", "terminal#2"]);
  });

  test("it is NOT the Processes surface", () => {
    // Processes folds the engine's background tasks — liveness and an owner.
    // This is a shell you type into. Both exist; neither replaced the other.
    expect(isPanelTab("processes")).toBe(true);
    expect(describePanelTab("processes").label).toBe("Processes");
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

  test("a detail id is a REQUEST and never a tab of its own (#693)", () => {
    // `issue:675` still NAMES an issue — a conversation chip, a GitHub link and
    // a layout saved before the change all say it that way — but it resolves to
    // the LIST surface, which opens the number inside itself. The same turn
    // `file:` took when files moved into the Editor.
    expect(migratePanelTab(issuePanelTab(675))).toBe("issues");
    expect(migratePanelTab(pullPanelTab(666))).toBe("pulls");
    // A malformed one is not a request for anything, so it is left alone and
    // the validator drops it, exactly as before.
    expect(migratePanelTab("issue:12abc")).toBe("issue:12abc");
    expect(isPanelTab("issue:12abc")).toBe(false);
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

describe("splitRoster", () => {
  /**
   * NO FOLD IN FRONT OF THE SPLIT — #877.
   *
   * This block used to test `groupWarps`, the fold that replaced the frozen
   * cockpit's second rail: a Warp run and its agents were rows on the one task
   * stream, grouped rather than stored apart, and the kind split had to happen
   * AFTER that fold or a run landed under Processes with its agents orphaned on
   * the Agents surface. Warp is retired, so `kind` is the whole rule and this
   * surface has no container rows left.
   */
  test("agents on one side, background work on the other", () => {
    const split = splitRoster([
      { id: "shell", kind: "background", state: "running", items: [] },
      { id: "plain", kind: "agent", state: "running", items: [] },
    ] as never);
    expect(split.agents.map((task) => task.id)).toEqual(["plain"]);
    expect(split.processes.map((task) => task.id)).toEqual(["shell"]);
  });

  test("a task with no kind at all is presumed an agent, matching the contract's denylist", () => {
    const split = splitRoster([{ id: "unkinded", state: "running", items: [] }] as never);
    expect(split.agents).toHaveLength(1);
    expect(split.processes).toHaveLength(0);
  });

  test("the split has no third side, and no task lands on two", () => {
    // ANTI-VACUITY, and #877's pin on this file: `groups` was a third bucket
    // holding a run plus its children, and every count on the tab strip had to
    // subtract it to avoid reading a four-agent fan-out as five running. A
    // re-added container row fails here rather than quietly appearing.
    const tasks = [
      { id: "shell", kind: "background", state: "running", items: [] },
      { id: "plain", kind: "agent", state: "running", items: [] },
      { id: "unkinded", state: "running", items: [] },
    ];
    const split = splitRoster(tasks as never);
    expect(Object.keys(split).sort()).toEqual(["agents", "processes"]);
    expect(split.agents.length + split.processes.length).toBe(tasks.length);
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

/**
 * AGENTS HOLDS THE CONVERSATIONS TOO — issue #381.
 *
 * The rail stopped drawing a delegated conversation as a child of the one that
 * delegated to it, and the relationship moved here. Two things have to be true
 * for that to be a move rather than a deletion: the surface must actually mount
 * the section, and the chooser card must say so — a card is the only thing that
 * tells a reader what a surface holds before they open it.
 */
describe("the Agents surface", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const source = fs.readFileSync(path.join(dir, "right-panel.tsx"), "utf8");

  test("its blurb names what the section holds, and no longer stops at sub-agents", () => {
    const { label, blurb } = describePanelTab("agents");
    expect(label).toBe("Agents");
    expect(blurb).toContain("conversations working for this one");
    expect(blurb).not.toBe("Sub-agents");
    // #877: the blurb named a surface this pane no longer draws.
    expect(blurb.toLowerCase()).not.toContain("warp");
  });

  test("the section is mounted, and it is given the session whose relationships it describes", () => {
    expect(source).toContain("<RelatedConversations");
    const mount = source.slice(source.indexOf("<RelatedConversations"), source.indexOf("/>", source.indexOf("<RelatedConversations")));
    // Without the id there is nothing to ask about; without the host a remote
    // cockpit would ask the local engine about a remote session.
    expect(mount).toContain("sessionId");
    expect(mount).toContain("hostId");
  });

  test("an empty roster still draws the section — a surface must not contradict its own contents", () => {
    // "Sub-agents appear here as they work" above four conversations that ARE
    // working is the empty state arguing with the rows beneath it.
    const surface = source.slice(source.indexOf("function AgentsSurface"), source.indexOf("function ProcessesSurface"));
    const empty = surface.slice(surface.indexOf("Sub-agents appear here"));
    expect(empty.slice(0, empty.indexOf("const live"))).toContain("{related}");
  });
});

/**
 * THE TAB STRIP IS A DRAG HANDLE — issue #279, the panel half.
 *
 * ASSERTED AS SOURCE, not as a render: `RightPanel` is the cockpit's whole
 * right-hand side and mounting it to read one attribute would be a test about
 * everything else. What matters structurally is WHICH element carries the drag,
 * and that is a question the source answers exactly.
 */
describe("the panel's tabs drag to reorder", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const raw = fs.readFileSync(path.join(dir, "right-panel.tsx"), "utf8");
  const opens = raw.indexOf('role="tablist"');
  // Comments stripped, for the reason `context-menus.test.tsx` gives: a scan
  // that read prose would fire on the explanation and teach the next person to
  // delete it. (These very rules are explained in the strip's own comment.)
  const strip = raw
    .slice(opens, raw.indexOf('aria-label="Open a surface"', opens))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  test("the tab itself is draggable, and it is the one element that is", () => {
    expect(strip).toContain("draggable");
    // Not the buttons inside it: those are the click targets, and a <button> is
    // not draggable by default, so the two gestures never compete. Anything
    // that later wants a right-press on a tab must wrap the CONTENT for the
    // same reason the session row and the project header do.
    const button = strip.slice(strip.indexOf("<button"));
    expect(button).not.toContain("draggable");
  });

  test("the drop mark is an inset shadow, not a border", () => {
    // A border appearing on drag-over widens the tab on the frame it appears
    // and shoves the rest of the strip sideways under the pointer.
    expect(strip).toContain("shadow-[inset_2px_0_0_0_var(--color-primary)]");
    expect(strip).toContain("shadow-[inset_-2px_0_0_0_var(--color-primary)]");
    expect(strip).not.toContain("border-l-2");
  });

  test("the drop asks for an index in the strip WITHOUT the carried tab", () => {
    // Which is what `movePanelTab` takes. Measuring against the strip as drawn
    // instead would make every rightward move off by one.
    // By INSTANCE id, not by kind: with two Editors open, filtering by kind
    // would drop both and move the wrong one.
    expect(strip).toContain("const rest = tabs.filter((other) => other.id !== dragged);");
    expect(strip).toContain('onMoveTab?.(dragged, rest.findIndex((other) => other.id === id) + (side === "after" ? 1 : 0));');
  });
});
