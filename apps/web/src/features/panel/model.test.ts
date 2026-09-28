// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  browserPanelTab,
  describePanelTab,
  filePanelTabPath,
  isFilePanelTab,
  isMultiInstancePanelTab,
  isPanelTab,
  isRestorablePanelTab,
  issuePanelNumber,
  issuePanelTab,
  panelTabForPath,
  pdfPanelPath,
  pdfPanelTab,
  pullPanelNumber,
  pullPanelTab,
  type PanelTab,
} from "./model";
import { emptyPanelTabs, openPanelTab } from "./tabs";

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
    expect(isPanelTab("files")).toBe(false);
  });
});

describe("the Run surface, which is now the Terminal's strip (#890)", () => {
  test("`run` is no longer a tab kind at all", () => {
    // Run and Terminal were two surfaces for one idea, each with its own
    // emulator drawing the same kind of bytes. A run is a CHIP now; leaving the
    // kind valid would let a saved layout restore a pane nothing renders.
    expect(isPanelTab("run")).toBe(false);
  });
});

describe("the Terminal surface", () => {
  test("is a real tab: it validates, it survives a restore, and it is not file-shaped", () => {
    // The panel restores tab ids from storage, so a surface that does not
    // validate here is one that silently disappears on the next reload — and
    // with it the id of a shell that is still running.
    expect(isPanelTab("terminal")).toBe(true);
    expect(isFilePanelTab("terminal")).toBe(false);
  });

  test("describes itself with no session and no shell", () => {
    const { label, blurb } = describePanelTab("terminal");
    expect(label).toBe("Terminal");
    expect(blurb.length).toBeGreaterThan(0);
  });

  test("is SINGLE-instance — a second shell is an inner tab, not an outer one", () => {
    // A Terminal carries its own strip of shells; the Editor and the Diff are still two.
    expect(isMultiInstancePanelTab("terminal")).toBe(false);
    expect(isMultiInstancePanelTab("editor")).toBe(true);
    expect(isMultiInstancePanelTab("diff")).toBe(true);
    expect(isMultiInstancePanelTab("processes")).toBe(false);
  });

  test("asking for a terminal twice focuses the one you have", () => {
    // The gesture that used to mint `terminal#2` is now the `+` inside the
    // surface, where a second shell costs no room in this strip.
    let state = openPanelTab(emptyPanelTabs<PanelTab>(), "terminal");
    state = openPanelTab(state, "terminal");
    expect(state.tabs.map((entry) => entry.id)).toEqual(["terminal"]);
    expect(state.activeTab).toBe("terminal");
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
    expect(panelTabForPath("docs/paper.pdf", [])).toBe("pdf:docs/paper.pdf");
    expect(panelTabForPath("docs/paper.pdf", ["data-science"])).toBe("pdf:docs/paper.pdf");
    // While the data-science pair keeps its gate.
    expect(panelTabForPath("analysis.ipynb", [])).toBe("file:analysis.ipynb");
    expect(panelTabForPath("analysis.ipynb", ["data-science"])).toBe("notebook:analysis.ipynb");
    // And markdown stays a `file:` tab — the file view renders it itself.
    expect(panelTabForPath("README.md", [])).toBe("file:README.md");
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

  test("a file-shaped id never restores into the strip", () => {
    const stored = ["diff", "file:a.ts", "notebook:b.ipynb", "issues", "pdf:c.pdf", "table:d.csv", "editor"];
    expect(stored.filter(isRestorablePanelTab)).toEqual(["diff", "issues", "editor"]);
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

  test("a detail id is a request and never restores as a tab of its own", () => {
    expect(isRestorablePanelTab(issuePanelTab(675))).toBe(false);
    expect(isRestorablePanelTab(pullPanelTab(666))).toBe(false);
    expect(isRestorablePanelTab("issues")).toBe(true);
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

describe("the Agents surface", () => {
  test("its blurb names what the section holds, and no longer stops at sub-agents", () => {
    const { label, blurb } = describePanelTab("agents");
    expect(label).toBe("Agents");
    expect(blurb).toContain("conversations working for this one");
    expect(blurb).not.toBe("Sub-agents");
    expect(blurb.toLowerCase()).not.toContain("warp");
  });
});
