/**
 * THE STRIP, RENDERED — what a person actually reads off the tabs.
 *
 * WHY THIS IS A SECOND FILE, and why it renders rather than asserting on
 * `describePanelTabInstance`. That function is already pinned next door in
 * lib/right-panel-tabs.test.ts; what it cannot say is whether the PANEL passes
 * it the right arguments. The suffix is conditional on a sibling of the same
 * kind being open (#322), and that condition is computed in `RightPanel` from
 * the strip it was handed — so the failure this guards is "two Editors, both
 * labelled Editor", which is invisible to a unit test of the formatter.
 *
 * `renderToStaticMarkup` reaches the strip because the tabs are ordinary DOM;
 * the menus inside them portal and render as nothing, which is fine — the
 * claim under test is the label text, and the menus have their own tests
 * (session/context-menus.render.test.tsx takes the same approach).
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RightPanel, type PanelTabItem } from "./right-panel";

const tab = (id: string, kind: string, params: Record<string, string> = {}): PanelTabItem =>
  ({ id, kind, params }) as PanelTabItem;

/**
 * The panel with a given strip, rendered SERVER-SIDE — with no `window` at all.
 *
 * The whole suite shares one process, and other files install a partial
 * `window` stub for their own storage tests and leave it there, so a render
 * that saw one would read whichever half-built object happened to be current.
 * Taking it away for the duration puts this render on the path every one of
 * these components is already written for (`typeof window === "undefined"`),
 * and puts it back so the next file finds what it left.
 */
const strip = (tabs: PanelTabItem[], active?: string) => {
  const had = (globalThis as { window?: unknown }).window;
  delete (globalThis as { window?: unknown }).window;
  try {
    return render(tabs, active);
  } finally {
    if (had !== undefined) (globalThis as { window?: unknown }).window = had;
  }
};

const render = (tabs: PanelTabItem[], active?: string) =>
  renderToStaticMarkup(
    <RightPanel
      sessionId="session_a"
      projectId="project_a"
      tabs={tabs}
      {...(active ? { tab: active } : {})}
      onTabChange={() => {}}
      onOpenTab={() => {}}
      onCloseTab={() => {}}
      onClose={() => {}}
    />,
  );

/** The labels in the strip, in order — each tab's `title` is its label, which
 *  is the one attribute that carries it without the surrounding chrome. */
function labels(markup: string): string[] {
  return [...markup.matchAll(/role="tab"[^>]*?title="([^"]*)"/g)].map((match) => match[1]!);
}

describe("a tab wears a suffix only when it has a sibling of its kind", () => {
  test("one Editor is just Editor, however many files it holds", () => {
    // The file is named by the Editor's own strip and by the file header; a
    // third telling of it, in the tab, is a word of chrome buying nothing.
    expect(labels(strip([tab("editor", "editor", { path: "README.md" })], "editor"))).toEqual(["Editor"]);
  });

  test("two Editors are told apart by their files", () => {
    const markup = strip(
      [tab("editor", "editor", { path: "README.md" }), tab("editor#2", "editor", { path: "apps/web/lib/utils.ts" })],
      "editor",
    );
    expect(labels(markup)).toEqual(["Editor · README.md", "Editor · utils.ts"]);
  });

  test("a kind with no sibling keeps its plain label beside kinds that have one", () => {
    const markup = strip(
      [tab("diff", "diff"), tab("editor", "editor", { path: "a.ts" }), tab("editor#2", "editor", { path: "b.ts" })],
      "diff",
    );
    expect(labels(markup)).toEqual(["Diff", "Editor · a.ts", "Editor · b.ts"]);
  });

  test("two Diffs with nothing to tell them apart stay readable rather than growing a dangling separator", () => {
    // The Diff surface has no filter to put in `params` yet; a label ending in
    // " · " would be worse than the same word twice.
    expect(labels(strip([tab("diff", "diff"), tab("diff#2", "diff")], "diff"))).toEqual(["Diff", "Diff"]);
  });
});

describe("the panel opens as wide as the widest thing in it (#357)", () => {
  /**
   * NOTHING IS REMEMBERED HERE, which is exactly the case under test: these
   * renders have no `window`, so the stored width comes back empty and the
   * panel falls through to its default. A person who has ever dragged this
   * panel never reaches that path — `lib/right-panel-layout.test.ts` states
   * the rule itself; this says the shell actually asks it.
   */
  const width = (markup: string) => markup.match(/--right-panel-width:(\d+)px/)?.[1];

  test("a strip of lists opens at the column width", () => {
    expect(width(strip([tab("diff", "diff")], "diff"))).toBe("480");
  });

  test("a notebook or a file beside its tree opens wide enough to read", () => {
    expect(width(strip([tab("editor", "editor", { path: "a.ipynb" })], "editor"))).toBe("720");
    expect(width(strip([tab("data", "data")], "data"))).toBe("720");
    // And from behind a list tab, because the room is the strip's need.
    expect(width(strip([tab("diff", "diff"), tab("editor", "editor")], "diff"))).toBe("720");
  });
});

describe("the strip is keyed by instance, not by kind", () => {
  test("every tab gets its own chip and its own close button", () => {
    const markup = strip([tab("editor", "editor", { path: "a.ts" }), tab("editor#2", "editor", { path: "b.ts" })], "editor#2");
    expect(labels(markup)).toHaveLength(2);
    expect(markup).toContain('aria-label="Close Editor · a.ts"');
    expect(markup).toContain('aria-label="Close Editor · b.ts"');
    // Exactly one of them is selected — the active INSTANCE, not the kind.
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
  });
});
