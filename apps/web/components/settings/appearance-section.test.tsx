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
    expect(host.textContent).toContain("A look is a theme pair");
  });

  /**
   * THE COPY TEACHES ONE COLOUR MODEL — the owner's "we have too many ways of
   * selecting colour themes: themes, colours, looks". There are two nouns, and
   * the two groups that own them each state the same definition rather than
   * leaving a reader to infer that a "theme" and a "look" differ at all.
   */
  test("a theme is a palette per half, and a look is a theme pair with things saved around it", () => {
    expect(host.textContent).toContain("A theme is a palette — one for the light half, one for the dark");
    expect(host.textContent).toContain("A look is a theme pair");
    // And the backdrop says which of the two it belongs to.
    expect(host.textContent).toContain("It is part of the look, not part of the palette");
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

/**
 * THE SHELF IS A LIST — issue #471.
 *
 * It was a horizontal rank of 128px thumbnails inside a vertically-scrolling
 * pane, so a shelf of more than four hid the rest sideways, a card had room for
 * a picture and a truncated name, and every action was behind a hover. What is
 * pinned is the shape that replaced it: no sideways scroller, a row per look
 * carrying a line about what it holds, and actions that are real buttons.
 */
describe("the Looks shelf reads as a list", () => {
  /** The section `SettingsGroup` draws for the shelf, found by its caption. */
  function looksGroup(): HTMLElement | null {
    return [...host.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Looks") ?? null;
  }

  test("nothing in it scrolls sideways", () => {
    expect(looksGroup()?.querySelector(".overflow-x-auto")).toBeNull();
  });

  test("every starter is a row of its own, with a Wear button on it", () => {
    // Six starters (lib/starter-looks.ts), none of them worn on a fresh store.
    const wears = [...(looksGroup()?.querySelectorAll("button") ?? [])].filter((button) => button.textContent === "Wear");
    expect(wears.length).toBeGreaterThanOrEqual(6);
  });

  test("a row says what the look carries, not just what it is called", () => {
    // Palette · backdrop · the two faces. "Paper" is the starter built on the
    // identity theme with no backdrop at all, which is the line most likely to
    // read wrong if the summary were assembled from the wrong members.
    const text = looksGroup()?.textContent ?? "";
    expect(text).toContain("Telar · no backdrop · Geist / Geist Mono");
    expect(text).toContain("Tide · gradient ·");
  });

  test("the starters carry no rename, export or delete — there is no card yet", () => {
    const labels = [...(looksGroup()?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("aria-label") ?? "");
    expect(labels.filter((label) => label.startsWith("Rename "))).toEqual([]);
    expect(labels.filter((label) => label.startsWith("Delete "))).toEqual([]);
  });
});

/**
 * COMPOSE IS WHERE THE BACKDROP GROUP LANDS — issue #471.
 *
 * With nothing behind the app the group used to open on "None", which is a
 * picker with no picker in it: a sentence saying the canvas paints flat, and
 * three other words to guess between. Compose is the kind that can build any of
 * the others, so it leads the control and is where the group arrives.
 */
describe("the Backdrop group", () => {
  function backdropGroup(): HTMLElement | null {
    return [...host.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Backdrop") ?? null;
  }

  test("Compose is the first segment", () => {
    const segments = [...(backdropGroup()?.querySelectorAll('button[aria-pressed]') ?? [])].map((button) => button.textContent);
    expect(segments.slice(0, 4)).toEqual(["Compose", "Gradient", "Image", "None"]);
  });

  test("with nothing behind the app, the group opens on the composer rather than on None", () => {
    // A fresh store has no backdrop, and arriving must not write one: the
    // composer's empty stack composes to nothing and is refused.
    const pressed = [...(backdropGroup()?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((button) => button.textContent);
    expect(pressed).toContain("Compose");
    expect(backdropGroup()?.textContent).not.toContain("The canvas paints flat");
  });
});

/**
 * THE PALETTE LEADS WITH A THEME, NOT WITH SIXTEEN TOKENS — issue #471.
 *
 * "You basically need to know how each component of each surface reacts to
 * these and it's complicated to see that." The sixteen-token editor was the
 * first thing in the Colour group and the only way to change a colour, so every
 * colour decision began by working out which of sixteen names governs the thing
 * you are looking at. The theme pickers lead now, the tokens are folded away,
 * and each token row says where it paints.
 */
describe("the Colour group", () => {
  function colourGroup(): HTMLElement | null {
    return [...host.querySelectorAll("section")].find((section) => section.querySelector("h4")?.textContent === "Colour") ?? null;
  }

  test("the two theme pickers are rows, and they come before the tokens", () => {
    const group = colourGroup();
    expect(group?.querySelector("#settings-row-colour-light-theme")).not.toBeNull();
    expect(group?.querySelector("#settings-row-colour-dark-theme")).not.toBeNull();

    const html = group?.innerHTML ?? "";
    expect(html.indexOf("Light theme")).toBeGreaterThan(-1);
    expect(html.indexOf("Light theme")).toBeLessThan(html.indexOf("Edit tokens"));
  });

  test("the sixteen tokens sit behind a closed disclosure", () => {
    const details = colourGroup()?.querySelector("details");
    expect(details).not.toBeNull();
    // Closed on arrival: the tokens are the tool you reach for after choosing a
    // theme, not the thing that greets you.
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("Edit tokens");
  });

  test("every token row says where it paints, not just what it is called", () => {
    // Rendered even while the disclosure is closed — `details` hides its
    // content, it does not unmount it — which is what lets this assert the
    // pairing rather than the folding.
    const tokens = colourGroup()?.querySelector("details")?.textContent ?? "";
    expect(tokens).toContain("The canvas the whole window sits on");
    expect(tokens).toContain("Every hairline in the app");
    expect(tokens).toContain("A rail row under the pointer");
  });

  test("a built-in says it will be copied before the first edit lands", () => {
    // The fork is `editActiveHalf`'s contract, and a reader who discovers it
    // afterwards has already got a theme they did not ask to create.
    expect(colourGroup()?.textContent).toContain("is a built-in. The first edit copies it");
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
