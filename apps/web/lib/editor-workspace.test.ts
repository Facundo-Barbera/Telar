/**
 * The Editor's file strip.
 *
 * What matters here is what CANNOT happen: a file somebody pinned, or has
 * unsaved work in, must never be replaced by the next click in the tree — while
 * browsing nine files to find one must not leave nine tabs behind. Those two
 * pull against each other, and the preview slot is the whole answer, so most of
 * these tests are about its edges.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  activateEditorFile,
  activeEditorFile,
  closeEditorFile,
  editorFileForPath,
  editorFromLegacyTabs,
  editorPathsAfter,
  emptyEditor,
  otherEditorPaths,
  openInEditor,
  pinEditorFile,
  readEditor,
  writeEditor,
  type EditorState,
} from "./editor-workspace";

const code = (path: string) => ({ path, view: "code" as const });
const paths = (state: EditorState) => state.files.map((file) => `${file.path}${file.pinned ? "!" : ""}`);

describe("the preview slot", () => {
  test("a single click borrows one slot, and the next single click takes it back", () => {
    // Clicking through a directory is LOOKING. Nine clicks must not cost nine
    // tabs — that is what made a tab per file unusable in the first place.
    let state = openInEditor(emptyEditor(), code("a.ts"));
    state = openInEditor(state, code("b.ts"));
    state = openInEditor(state, code("c.ts"));
    expect(paths(state)).toEqual(["c.ts"]);
    expect(state.activePath).toBe("c.ts");
  });

  test("a double click keeps its file, and the next preview opens beside it", () => {
    let state = openInEditor(emptyEditor(), code("a.ts"), "pin");
    state = openInEditor(state, code("b.ts"));
    expect(paths(state)).toEqual(["a.ts!", "b.ts"]);
    state = openInEditor(state, code("c.ts"));
    // Only the preview moved.
    expect(paths(state)).toEqual(["a.ts!", "c.ts"]);
  });

  test("the preview is replaced IN PLACE, so the strip does not reshuffle", () => {
    // Appending-and-removing would slide every tab to the right of the preview
    // one position left, under the pointer, mid-click.
    let state = openInEditor(emptyEditor(), code("pinned-left.ts"), "pin");
    state = openInEditor(state, code("preview.ts"));
    state = openInEditor(state, code("pinned-right.ts"), "pin");
    expect(paths(state)).toEqual(["pinned-left.ts!", "pinned-right.ts!"]);
  });

  test("clicking a file that is already open focuses it and never duplicates it", () => {
    let state = openInEditor(openInEditor(emptyEditor(), code("a.ts"), "pin"), code("b.ts"));
    state = openInEditor(state, code("a.ts"));
    expect(paths(state)).toEqual(["a.ts!", "b.ts"]);
    expect(state.activePath).toBe("a.ts");
  });

  test("a preview click never un-pins what it lands on", () => {
    // The dangerous direction: a pin is a promise that the file stays.
    const state = openInEditor(openInEditor(emptyEditor(), code("a.ts"), "pin"), code("a.ts"));
    expect(paths(state)).toEqual(["a.ts!"]);
  });

  test("a deliberate open promotes the preview rather than opening a second tab", () => {
    // Double-clicking the file you just single-clicked is exactly how a person
    // says "keep this one".
    const state = openInEditor(openInEditor(emptyEditor(), code("a.ts")), code("a.ts"), "pin");
    expect(paths(state)).toEqual(["a.ts!"]);
  });

  test("the first keystroke pins — which is what makes replacement safe", () => {
    // Every replacement above is only defensible because the preview slot can
    // never hold edited work: the editor pins on the first change.
    let state = openInEditor(emptyEditor(), code("a.ts"));
    state = pinEditorFile(state, "a.ts");
    state = openInEditor(state, code("b.ts"));
    expect(paths(state)).toEqual(["a.ts!", "b.ts"]);
  });

  test("pinning an unknown path changes nothing, and pinning twice is the same state", () => {
    const state = pinEditorFile(openInEditor(emptyEditor(), code("a.ts")), "a.ts");
    expect(pinEditorFile(state, "a.ts")).toBe(state);
    expect(pinEditorFile(state, "nowhere.ts")).toBe(state);
  });

  test("a notebook is never a preview", () => {
    // It is a thing you work IN — cells with drafts and a kernel — and its
    // unsaved state is not something the first keystroke here can see.
    let state = openInEditor(emptyEditor(), { path: "a.ipynb", view: "notebook" });
    state = openInEditor(state, code("b.ts"));
    expect(paths(state)).toEqual(["a.ipynb!", "b.ts"]);
  });
});

describe("closing", () => {
  test("focus moves to the file on the right, then to the new last one", () => {
    let state: EditorState = { files: [], explorerOpen: true };
    for (const path of ["a.ts", "b.ts", "c.ts"]) state = openInEditor(state, code(path), "pin");
    const middle = closeEditorFile(activateEditorFile(state, "b.ts"), "b.ts");
    expect(middle.activePath).toBe("c.ts");
    expect(closeEditorFile(activateEditorFile(state, "c.ts"), "c.ts").activePath).toBe("b.ts");
  });

  test("closing an inactive file does not steal focus", () => {
    let state: EditorState = { files: [], explorerOpen: true };
    for (const path of ["a.ts", "b.ts"]) state = openInEditor(state, code(path), "pin");
    expect(closeEditorFile(state, "a.ts").activePath).toBe("b.ts");
  });

  test("closing the last file leaves an Editor with no file open — not an error", () => {
    const state = closeEditorFile(openInEditor(emptyEditor(), code("a.ts")), "a.ts");
    expect(state.files).toEqual([]);
    expect("activePath" in state).toBe(false);
    expect(activeEditorFile(state)).toBeUndefined();
  });

  test("closing a file that is not open changes nothing", () => {
    const before = openInEditor(emptyEditor(), code("a.ts"));
    expect(closeEditorFile(before, "elsewhere.ts")).toBe(before);
  });
});

/**
 * The strip's own "Close others" / "Close to the right" — which say which
 * files a sweep is about and close nothing themselves, so the refused-save
 * confirm keeps working on every file in the sweep. See the note above them.
 */
describe("which files a close verb sweeps", () => {
  const strip = () => {
    let state: EditorState = { files: [], explorerOpen: true };
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) state = openInEditor(state, code(path), "pin");
    return state;
  };

  test("others is everything but this one, in strip order", () => {
    expect(otherEditorPaths(strip(), "b.ts")).toEqual(["a.ts", "c.ts", "d.ts"]);
  });

  test("to the right is only what follows it — never what sits before it", () => {
    expect(editorPathsAfter(strip(), "b.ts")).toEqual(["c.ts", "d.ts"]);
    expect(editorPathsAfter(strip(), "d.ts")).toEqual([]);
    expect(editorPathsAfter(strip(), "a.ts")).toEqual(["b.ts", "c.ts", "d.ts"]);
  });

  test("a menu left open on a file that has since closed sweeps nothing at all", () => {
    // Otherwise a stale "Close others" would empty the strip around a tab
    // that is no longer in it — every file lost to name one that is gone.
    expect(otherEditorPaths(strip(), "gone.ts")).toEqual([]);
    expect(editorPathsAfter(strip(), "gone.ts")).toEqual([]);
  });

  test("one open file has no others and nothing to its right", () => {
    const one = openInEditor(emptyEditor(), code("a.ts"), "pin");
    expect(otherEditorPaths(one, "a.ts")).toEqual([]);
    expect(editorPathsAfter(one, "a.ts")).toEqual([]);
  });

  test("neither one closes anything — the state they were asked about is untouched", () => {
    const before = strip();
    otherEditorPaths(before, "b.ts");
    editorPathsAfter(before, "b.ts");
    expect(paths(before)).toEqual(["a.ts!", "b.ts!", "c.ts!", "d.ts!"]);
  });
});

describe("editorFileForPath", () => {
  test("the data-science pair is gated, the PDF viewer is not", () => {
    // The same rules the panel applied when a file was a top-level tab.
    expect(editorFileForPath("analysis.ipynb", false).view).toBe("code");
    expect(editorFileForPath("analysis.ipynb", true).view).toBe("notebook");
    expect(editorFileForPath("data.csv", true).view).toBe("table");
    expect(editorFileForPath("docs/paper.pdf", false).view).toBe("pdf");
    // Markdown is the text editor's own job — it renders it.
    expect(editorFileForPath("README.md", false).view).toBe("code");
    expect(editorFileForPath("src/weird:name.ts", false)).toEqual({ path: "src/weird:name.ts", view: "code" });
  });
});

describe("what survives a reload", () => {
  /** A localStorage the size of this test. The module reads `window` lazily on
   *  every call, so standing one up here is enough — and it is the only way to
   *  test a restore that has to survive a build that changed its own vocabulary. */
  function withStorage<T>(run: () => T): T {
    const store = new Map<string, string>();
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    };
    try {
      return run();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  }

  test("the open files, which one was active, and the tree's state come back", () => {
    withStorage(() => {
      let state = openInEditor(emptyEditor(), code("a.ts"), "pin");
      state = openInEditor(state, { path: "b.csv", view: "table" });
      writeEditor("session_1", state, 1);
      const restored = readEditor("session_1");
      expect(restored.files).toEqual([
        { path: "a.ts", view: "code", pinned: true },
        { path: "b.csv", view: "table", pinned: false },
      ]);
      expect(restored.activePath).toBe("b.csv");
      expect(restored.explorerOpen).toBe(true);
    });
  });

  test("a session that never opened a file restores empty rather than guessing", () => {
    withStorage(() => expect(readEditor("never-seen").files).toEqual([]));
  });

  test("a view kind this build no longer has is dropped, not rendered blank", () => {
    withStorage(() => {
      (globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem(
        "telar:editor",
        JSON.stringify({
          version: 1,
          sessions: { s: { files: [{ path: "a.ts", view: "code", pinned: true }, { path: "b.ts", view: "hologram" }, { path: "", view: "code" }], explorerOpen: false, touchedAt: 1 } },
        }),
      );
      const restored = readEditor("s");
      expect(restored.files.map((file) => file.path)).toEqual(["a.ts"]);
      // And a tree somebody collapsed stays collapsed.
      expect(restored.explorerOpen).toBe(false);
    });
  });

  test("an active path naming a file that is gone falls back to the last one", () => {
    withStorage(() => {
      (globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem(
        "telar:editor",
        JSON.stringify({ version: 1, sessions: { s: { files: [{ path: "a.ts", view: "code", pinned: true }], activePath: "closed.ts", explorerOpen: true, touchedAt: 1 } } }),
      );
      expect(readEditor("s").activePath).toBe("a.ts");
    });
  });

  test("a stored blob from another schema is discarded, not half-read", () => {
    withStorage(() => {
      (globalThis as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage.setItem("telar:editor", JSON.stringify({ version: 99, sessions: { s: { files: [{ path: "a.ts", view: "code" }] } } }));
      expect(readEditor("s").files).toEqual([]);
    });
  });
});

describe("editorFromLegacyTabs (the upgrade path)", () => {
  test("files that were top-level panel tabs come back as the Editor's files, pinned", () => {
    // They were deliberate opens under the old rules; demoting them to one
    // shared preview slot would throw all but one of them away on upgrade.
    const state = editorFromLegacyTabs(["diff", "file:src/a.ts", "notebook:nb.ipynb", "issues", "pdf:doc.pdf", "table:d.csv"], "notebook:nb.ipynb");
    expect(state).toBeDefined();
    expect(state!.files).toEqual([
      { path: "src/a.ts", view: "code", pinned: true },
      { path: "nb.ipynb", view: "notebook", pinned: true },
      { path: "doc.pdf", view: "pdf", pinned: true },
      { path: "d.csv", view: "table", pinned: true },
    ]);
    expect(state!.activePath).toBe("nb.ipynb");
  });

  test("a path with a colon survives, and a bare prefix names nothing", () => {
    expect(editorFromLegacyTabs(["file:src/weird:name.ts"])!.files[0]!.path).toBe("src/weird:name.ts");
    expect(editorFromLegacyTabs(["file:", "pdf:"])).toBeUndefined();
  });

  test("a panel with no files at all has nothing to migrate", () => {
    // Which is the signal not to open an Editor tab for a session that never
    // had a file open.
    expect(editorFromLegacyTabs(["diff", "issues", "browser:p1"])).toBeUndefined();
  });

  test("the last file is active when the stored active tab was not a file", () => {
    expect(editorFromLegacyTabs(["file:a.ts", "file:b.ts"], "diff")!.activePath).toBe("b.ts");
  });
});
