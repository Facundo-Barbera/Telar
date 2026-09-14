/**
 * THE APPEARANCE PANE IS STACKED GROUPS, NOT TABS — issue #399.
 *
 * WHAT IS ACTUALLY BEING GUARDED. The complaint was not that any one control
 * was wrong; it was that three quarters of the pane was behind a `Tabs` strip,
 * so "what can I change here?" could only be answered by clicking four times,
 * and settings search pointed at rows that did not exist until you did. Both
 * facts are structural, and both are invisible to a test of any single control
 * — so what is pinned here is the SHAPE: every group on the page at once, no
 * tablist anywhere, and the Window rows carrying the anchors the search index
 * computes for them without ever rendering the pane.
 *
 * MOUNTED, NOT SERVER-RENDERED. Almost everything on this pane hangs off
 * `mounted` — the live look is photographed from the stores on the client, and
 * a server render deliberately holds every draft-fed group back to keep
 * hydration honest. `renderToStaticMarkup` would therefore assert that four of
 * the five groups are absent, which is the opposite of the claim.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pane's own reads of the world, stubbed to the quiet answer. None of them
// is what this file is about: the appearance home is a file the engine serves
// (absent here), and the host look is another window's published appearance.
mock.module("@/lib/appearance-home", () => ({
  readAppearanceHome: async () => ({ themes: [], looks: [], unreadable: [] }),
  mergeById: (mine: unknown[]) => mine,
}));

const { AppearanceSection } = await import("./appearance-section");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  window.localStorage.clear();
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<AppearanceSection />);
  });
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

/** The group captions `SettingsGroup` draws, in the order they are stacked. */
function captions(): string[] {
  return [...host.querySelectorAll("h4")].map((heading) => heading.textContent ?? "");
}

describe("the pane is a stack of settings groups", () => {
  test("every group is on the page at once, in reading order", () => {
    // Start from something, change its colour, then its scene, then its type —
    // and last the window, which is the only group that is not part of a look.
    expect(captions()).toEqual(["Looks", "Colour", "Backdrop", "Type", "Window"]);
  });

  test("there is no tab strip left anywhere on it", () => {
    // The regression this file exists for: a group put back behind a word.
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });

  test("each group says what it is for, under its title", () => {
    // `SettingsGroup`'s description is the sentence the panel headers never had
    // room for — a mono `WINDOW` chip cannot say that none of it travels in a
    // look.
    expect(host.textContent).toContain("None of it travels in a look");
    expect(host.textContent).toContain("Whole appearances");
  });
});

describe("the rows settings search points at", () => {
  test("the Window rows carry the anchor the index computes for them", () => {
    // The two halves of the contract in lib/settings-search.ts: the index
    // derives an id without rendering, and `Row` stamps the same one as it
    // renders. They agree only while the group heading and the pane id do.
    const indexed = SETTINGS_SEARCH_INDEX.entries.filter((entry: { pageId: string }) => entry.pageId === "appearance");
    const ids = indexed.map((entry: { id: string }) => entry.id);
    expect(ids).toContain("settings-row-appearance-window-translucency");
    expect(ids).toContain("settings-row-appearance-window-glass");
    expect(ids).toContain("settings-row-appearance-window-show-through");
    expect(ids).toContain("settings-row-appearance-type-accent");
  });

  test("the rows on the page derive the GROUP half of those ids", () => {
    /**
     * THE PANE HALF IS THE SHELL'S AND IS ABSENT HERE, on purpose. `Row` reads
     * its pane from `SettingsShell`'s context (settings-shell.tsx), and this
     * mounts the section on its own — so the ids it stamps are group-and-label,
     * `settings-row-window-show-through`. That is exactly the half #399 moved:
     * before, these rows had no group at all and derived
     * `settings-row-show-through`. The pane half is pinned by
     * settings-registry.test.ts, against the same `settingsRowId`.
     *
     * Translucency and Glass need the macOS shell to exist at all, so they are
     * not assertable in a browser tab; Show-through and Accent are, and they
     * are enough to prove both groups supply their context.
     */
    expect(host.querySelector("#settings-row-window-show-through")).not.toBeNull();
    expect(host.querySelector("#settings-row-type-accent")).not.toBeNull();
  });

  test("the backdrop's second Show-through does not claim the Window row's anchor", () => {
    // ONE VALUE, TWO HONEST HOMES — and exactly one destination. Two rows
    // deriving one id would make `getElementById` answer whichever came first,
    // so the backdrop copy is stamped by hand.
    const claimed = [...host.querySelectorAll('[id^="settings-row-"]')].map((row) => row.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).toContain("settings-row-appearance-backdrop-show-through");
    expect(claimed).toContain("settings-row-window-show-through");
  });
});

describe("the masthead", () => {
  test("rides the top of the scroller rather than scrolling away with the first group", () => {
    // Apply and Discard sit here, and the pane below them is now five groups
    // tall: a masthead that scrolled off left "is this saved?" with no answer
    // on screen.
    const name = host.querySelector('[aria-label="Look name"]');
    const strip = name?.closest("div");
    expect(strip?.className).toContain("sticky");
    expect(strip?.className).toContain("top-0");
  });

  test("still says whether the look is worn or being previewed", () => {
    // Nothing about the write model moved in #399 — only where the groups are.
    expect(host.textContent).toContain("Worn");
    expect(host.textContent).toContain("Save look");
  });
});
