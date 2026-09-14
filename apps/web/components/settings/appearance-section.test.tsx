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
 * MOUNTED, NOT SERVER-RENDERED. The backdrop group reads payloads that live in
 * localStorage, so it holds back to "nothing under the app" for the one render
 * that happens before the stores can be read. `renderToStaticMarkup` would
 * therefore assert against a pane in its pre-hydration state, which is not the
 * pane this file is about.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SlidersHorizontalIcon } from "lucide-react";
import { Row, SettingsGroup, SettingsShell } from "./settings-shell";
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
    // Start from something whole, compose it, then its type, and last the
    // window — the only group that is not part of a look.
    expect(captions()).toEqual(["Looks", "Composer", "Type and surfaces", "Window"]);
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
    expect(host.textContent).toContain("A look is a whole composition");
  });

  /**
   * THE COPY TEACHES ONE MODEL — the owner's "we have too many ways of selecting
   * colour themes: themes, colours, looks", and then "themes should not exist".
   * There is ONE noun left. The composer's own description says what a
   * composition is, and the gallery's says a look is one saved.
   */
  test("there is no theme left to pick, only a composition and looks of it", () => {
    expect(host.textContent).toContain("Light and dark are two states of one composition");
    expect(host.textContent).toContain("A look is a whole composition");
    // The vocabulary the model deleted, gone from the copy as well as the code.
    expect(host.textContent).not.toContain("theme pair");
    expect(host.textContent).not.toContain("Light theme");
    expect(host.textContent).not.toContain("Backdrop");
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
    expect(ids).toContain("settings-row-appearance-type-and-surfaces-accent");
    expect(ids).toContain("settings-row-appearance-composer-base");
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
     * not assertable in a browser tab; the rest are.
     */
    expect(host.querySelector("#settings-row-window-show-through")).not.toBeNull();
    expect(host.querySelector("#settings-row-type-and-surfaces-accent")).not.toBeNull();
    expect(host.querySelector("#settings-row-composer-base")).not.toBeNull();
  });

  test("no row claims an anchor twice", () => {
    // Show-through used to be rendered in two groups, which made
    // `getElementById` answer whichever came first. There is one now.
    const claimed = [...host.querySelectorAll('[id^="settings-row-"]')].map((row) => row.id);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

/**
 * THE GALLERY IS A LIST, AND IT IS THE ONLY PRESET SYSTEM — issue #471.
 *
 * It was a horizontal rank of 128px thumbnails inside a vertically-scrolling
 * pane, with a separate LIBRARY of themes underneath answering an overlapping
 * question. What is pinned is the shape that replaced both: no sideways
 * scroller, a row per look carrying a line about what it holds, actions that are
 * real buttons, and no second grid anywhere.
 */
/**
 * A TABLE, BECAUSE THE LIST WAS TOO LONG — round three of #471. "The looks UI
 * is too long; when you land on the looks you have to scroll a lot. We should
 * use tables for this like we do in other interfaces." Ten built-ins have to
 * fit a short window, which is what these assertions are actually about.
 */
describe("the Looks gallery reads as a table", () => {
  /** The section `SettingsGroup` draws for the gallery, found by its caption. */
  function looksGroup(): HTMLElement | null {
    return [...host.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Looks") ?? null;
  }

  test("nothing in it scrolls, sideways or otherwise", () => {
    expect(looksGroup()?.querySelector(".overflow-x-auto")).toBeNull();
    // A scroll box inside a scrolling pane is the thing the table replaced.
    expect(looksGroup()?.querySelector(".overflow-y-auto")).toBeNull();
    expect([...(looksGroup()?.querySelectorAll("*") ?? [])].some((node) => /(^|\s)max-h-/.test(node.className ?? ""))).toBe(false);
  });

  test("it is one table with a row per look, headed by what the columns are", () => {
    const table = looksGroup()?.querySelector("table");
    expect(table).not.toBeNull();
    expect([...(table?.querySelectorAll("thead th") ?? [])].map((cell) => cell.textContent)).toEqual(["Look", "Carries", "Actions"]);
    // Ten built-ins (lib/built-in-looks.ts) and nothing saved on a fresh store.
    expect(table?.querySelectorAll("tbody tr") ?? []).toHaveLength(10);
  });

  test("every default is a row of its own, with a Wear button on it", () => {
    // None of them worn on a fresh store — except Telar, which IS the fresh
    // store's composition, and whose Wear is therefore disabled.
    const wears = [...(looksGroup()?.querySelectorAll("button") ?? [])].filter((button) => button.textContent === "Wear");
    expect(wears.length).toBeGreaterThanOrEqual(9);
  });

  /** THE NAME IS THE ROW'S ACTION. Wearing is what a reader came here to do, so
   *  it is the one control that is never behind a hover. */
  test("a look's name wears it, and says so", () => {
    const named = [...(looksGroup()?.querySelectorAll("tbody button") ?? [])].find((button) => button.textContent === "Dusk");
    expect(named?.getAttribute("title")).toBe("Wear Dusk");
  });

  test("a row says what the look carries, not just what it is called", () => {
    const text = looksGroup()?.textContent ?? "";
    // A built-in says what it is in its own words; every look says its accent
    // and its two faces.
    expect(text).toContain("The app's own colours");
    expect(text).toContain("Tide, under a dusk gradient");
    expect(text).toContain("Geist / Geist Mono");
  });

  test("the defaults carry no rename, export or delete — there is no card yet", () => {
    const labels = [...(looksGroup()?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("aria-label") ?? "");
    expect(labels.filter((label) => label.startsWith("Rename "))).toEqual([]);
    expect(labels.filter((label) => label.startsWith("Delete "))).toEqual([]);
  });

  test("the worn one is the one the window actually has on", () => {
    // A fresh store is Telar's own composition, and exactly one row may claim
    // it — an id test would mark none, and a colours-only test would mark the
    // scenic looks built on the same base as well.
    const worn = looksGroup()?.querySelectorAll('[title="The window has this look on"]') ?? [];
    expect(worn).toHaveLength(1);
  });
});

/**
 * THE COMPOSER IS THE THEME — issue #471.
 *
 * "Gradient and theme are different things here. We inject the gradients over
 * the theme, where I always thought that a gradient would be part of a theme.
 * Themes should not exist." So the Colour group's two theme pickers and the
 * Backdrop group's four-way mode picker are one group with one model: a base
 * colour, a stack of layers over it, and the sixteen tokens folded away as
 * OVERRIDES of what the base derived.
 */
describe("the Composer group", () => {
  function composerGroup(): HTMLElement | null {
    return [...host.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Composer") ?? null;
  }

  test("the light/dark switch is the first control, and it is a pair", () => {
    const segments = [...(composerGroup()?.querySelectorAll("button[aria-pressed]") ?? [])].map((button) => button.textContent);
    expect(segments.slice(0, 2)).toEqual(["Light", "Dark"]);
  });

  test("the base leads, and the layers follow it", () => {
    const group = composerGroup();
    expect(group?.querySelector("#settings-row-composer-base")).not.toBeNull();
    const html = group?.innerHTML ?? "";
    expect(html.indexOf("Base")).toBeGreaterThan(-1);
    expect(html.indexOf("Base")).toBeLessThan(html.indexOf("Layers"));
  });

  test("there is no mode picker: a gradient and an image are layer types", () => {
    // The four-way None/Gradient/Image/Compose control is what the model
    // deleted — three of its four kinds were the fourth with a hole in it.
    const segments = [...(composerGroup()?.querySelectorAll("button[aria-pressed]") ?? [])].map((button) => button.textContent);
    expect(segments).not.toContain("Compose");
    expect(segments).not.toContain("None");
  });

  test("an empty stack says so rather than writing a backdrop", () => {
    // A fresh store has no layers, and arriving must not invent any.
    expect(composerGroup()?.textContent).toContain("Nothing over the base");
  });

  test("the sixteen tokens sit behind a closed disclosure", () => {
    const details = composerGroup()?.querySelector("details");
    expect(details).not.toBeNull();
    // Closed on arrival: they are the escape hatch you reach for after the base
    // has answered, not the thing that greets you.
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("Adjust colours");
  });

  test("every token row says where it paints, not just what it is called", () => {
    // Rendered even while the disclosure is closed — `details` hides its
    // content, it does not unmount it — which is what lets this assert the
    // pairing rather than the folding.
    const tokens = composerGroup()?.querySelector("details")?.textContent ?? "";
    expect(tokens).toContain("The canvas the whole window sits on");
    expect(tokens).toContain("Every hairline in the app");
    expect(tokens).toContain("A rail row under the pointer");
  });

  test("a token follows the base until it is set, and says so", () => {
    // The sparse override is the whole model: a value here is one somebody set
    // BY HAND, and a fresh composition has none — so every revert is inert.
    expect(composerGroup()?.textContent).toContain("Every colour here follows the base until you set it");
    const reverts = [...(composerGroup()?.querySelectorAll("button") ?? [])].filter((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith("Revert "),
    );
    expect(reverts.length).toBe(16);
    expect(reverts.every((button) => button.hasAttribute("disabled"))).toBe(true);
  });
});

/**
 * ONE READING COLUMN, AND APPEARANCE IS IN IT — issue #435.
 *
 * The shell sets the measure on a single wrapper around whatever pane is
 * showing (settings-shell.tsx), and Appearance used to be handed an opt-out
 * that swapped `max-w-2xl` for `max-w-[1400px]`. The result read as a second
 * application behind the same nav: cross from General and the column doubled.
 *
 * MOUNTED IN THE SHELL, NOT ASSERTED FROM A CLASS NAME. The claim is about an
 * ANCESTOR — which element actually constrains the pane — so both panes are
 * rendered inside a real `SettingsShell` and the constraining node is found by
 * walking up from something only that pane draws. A test that read the class
 * off the shell in isolation would still pass with the flag restored.
 */
describe("the pane sits in the same reading column as every other", () => {
  /** The shell's measure wrapper, found from a node only this pane renders. */
  function measureAround(marker: string): HTMLElement | null {
    const child = host.querySelector(marker);
    return child?.closest("div.mx-auto.w-full") ?? null;
  }

  async function renderShell(active: string, pane: React.ReactNode) {
    await act(async () => {
      root.render(
        <SettingsShell
          title="Settings"
          sections={[
            { id: "general", label: "General", icon: SlidersHorizontalIcon },
            { id: "appearance", label: "Appearance", icon: SlidersHorizontalIcon },
          ]}
          active={active}
          onSelect={() => undefined}
        >
          {pane}
        </SettingsShell>,
      );
    });
  }

  test("Appearance is wrapped in the measure General is wrapped in", async () => {
    await renderShell("appearance", <AppearanceSection />);
    const appearance = measureAround('[id^="settings-row-"]')?.className;

    await renderShell(
      "general",
      <SettingsGroup title="Settling">
        <Row label="Settle quiet sessions" />
      </SettingsGroup>,
    );
    // Any row will do as the handle — what is being compared is the ancestor
    // above it, not which row it is.
    const general = measureAround('[id^="settings-row-"]')?.className;

    expect(appearance).toBeDefined();
    expect(general).toBeDefined();
    // The SAME class, not merely a narrow one: the regression this guards is a
    // per-pane branch coming back, whatever width it picks.
    expect(appearance).toBe(general);
    expect(appearance).toContain("max-w-2xl");
  });

  test("the shell offers no per-pane width to opt out through", () => {
    // Pinned against source because the old escape hatch was a PROP: a pane
    // could be widened again without any rendered element here changing until
    // somebody passed it. Both halves are checked — the knob and its caller.
    const shell = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");
    expect(shell).not.toContain("max-w-[1400px]");
    expect(shell).not.toContain("wide?: boolean");
    expect(page).not.toContain("wide=");
  });
});

/**
 * EVERY CONTROL WRITES WHAT IT NAMES, AT ONCE — issue #471.
 *
 * The pane used to edit a DRAFT: a whole Look nobody was wearing, painted onto
 * the document to simulate wearing it, gated behind an Apply button in a sticky
 * masthead that also carried Discard, an undo arrow, a "Previewing" chip and a
 * name field. The owner's complaint was that bar, and the answer was to delete
 * the model behind it rather than to restyle it.
 *
 * WHAT IS GUARDED HERE IS THE ABSENCE. No individual control can show that
 * there is no longer a pending state — each of them looks the same either way —
 * so what is pinned is that the bar and its whole vocabulary are gone, and that
 * the one thing it carried which is still a real act, "Save look", survived
 * inside the group whose shelf it adds to.
 */
describe("there is no draft, and nothing to apply", () => {
  test("the masthead's vocabulary is gone from the pane", () => {
    for (const word of ["Apply", "Discard", "Previewing", "Undo"]) {
      expect(host.textContent).not.toContain(word);
    }
    expect(host.querySelector('[aria-label="Look name"]')).toBeNull();
  });

  test("nothing on the pane is sticky any more", () => {
    // The bar was the one sticky element here; a group is just a card.
    expect(host.querySelector(".sticky")).toBeNull();
  });

  test("Save look stands in the Looks group, beside the shelf it adds to", () => {
    const save = [...host.querySelectorAll("button")].find((button) => button.textContent === "Save look");
    expect(save).toBeDefined();
    // `SettingsGroup` draws its action on the caption line, outside the card —
    // the same block that carries the group's own <h4>.
    expect(save?.closest("section")?.querySelector("h4")?.textContent).toBe("Looks");
  });

  test("the colour scheme is a Window row now, not a masthead control", () => {
    // Which half this window wears is a fact about the window, and it is also
    // the half every colour control on the pane edits.
    expect(host.querySelector("#settings-row-window-colour-scheme")).not.toBeNull();
  });
});
