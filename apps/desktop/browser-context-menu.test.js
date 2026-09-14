const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const path = require("node:path");

const { browserContextMenuTemplate, SPELLING_SUGGESTION_LIMIT } = require("./browser-context-menu");

/** Ids only, separators marked — what the menu SAYS, without its wording. */
function ids(template) {
  return template.map((entry) => (entry.type === "separator" ? "—" : entry.id));
}

function find(template, id) {
  return template.find((entry) => entry.id === id);
}

/** A right-click on the page itself: nothing under the pointer. */
const BARE = { x: 40, y: 60, pageURL: "https://example.com/article" };

describe("the page's context menu", () => {
  test("a click on the page offers navigation, the source, and Inspect", () => {
    expect(ids(browserContextMenuTemplate(BARE, { canGoBack: true, canGoForward: false }))).toEqual([
      "back",
      "forward",
      "reload",
      "—",
      "view-source",
      "inspect",
    ]);
  });

  test("Back and Forward are enabled from the tab's history, not guessed", () => {
    const nowhere = browserContextMenuTemplate(BARE, {});
    expect(find(nowhere, "back").enabled).toBe(false);
    expect(find(nowhere, "forward").enabled).toBe(false);
    // Reload always works — there is always a page to reload.
    expect(find(nowhere, "reload").enabled).toBe(true);
    const both = browserContextMenuTemplate(BARE, { canGoBack: true, canGoForward: true });
    expect(find(both, "back").enabled).toBe(true);
    expect(find(both, "forward").enabled).toBe(true);
  });

  test("Inspect is on EVERY menu — it is the one row #423 exists for", () => {
    const everywhere = [
      BARE,
      { ...BARE, linkURL: "https://example.com/other" },
      { ...BARE, hasImageContents: true, srcURL: "https://example.com/cat.png" },
      { ...BARE, selectionText: "some words" },
      { ...BARE, isEditable: true },
      { pageURL: "about:blank" },
      {},
    ];
    for (const params of everywhere) {
      expect(ids(browserContextMenuTemplate(params, {}))).toContain("inspect");
    }
  });

  test("View Page Source is offered only where there is a web page to view", () => {
    // `view-source:` wraps http(s) and nothing else; a row that opened a tab on
    // an error would be this menu lying about what it can do.
    expect(ids(browserContextMenuTemplate({ pageURL: "about:blank" }, {}))).not.toContain("view-source");
    expect(ids(browserContextMenuTemplate({ pageURL: "file:///tmp/guide.html" }, {}))).not.toContain("view-source");
    expect(ids(browserContextMenuTemplate({}, {}))).not.toContain("view-source");
    expect(find(browserContextMenuTemplate(BARE, {}), "view-source").value).toBe("https://example.com/article");
  });

  test("NAVIGATION IS FOR THE PAGE, not for the thing you right-clicked", () => {
    // Chrome's rule, and the one people notice only when it is broken: three
    // navigation rows above "Copy Link" is a menu that forgot what it was asked.
    for (const params of [
      { ...BARE, linkURL: "https://example.com/other" },
      { ...BARE, hasImageContents: true, srcURL: "https://example.com/cat.png" },
      { ...BARE, selectionText: "some words" },
      { ...BARE, isEditable: true },
    ]) {
      expect(ids(browserContextMenuTemplate(params, { canGoBack: true }))).not.toContain("back");
    }
  });
});

describe("a link, an image, a selection", () => {
  test("a link opens in a new tab or copies, and carries its URL as the value", () => {
    const template = browserContextMenuTemplate({ ...BARE, linkURL: "https://example.com/other" }, {});
    expect(ids(template)).toEqual(["open-link-new-tab", "copy-link", "—", "view-source", "inspect"]);
    expect(find(template, "open-link-new-tab").value).toBe("https://example.com/other");
    expect(find(template, "copy-link").value).toBe("https://example.com/other");
  });

  test("an image needs REAL image contents, not merely a srcURL", () => {
    // `srcURL` is set for any media element; `hasImageContents` is Chromium's
    // answer to "is there a bitmap here to copy or save".
    const media = browserContextMenuTemplate({ ...BARE, srcURL: "https://example.com/clip.mp4" }, {});
    expect(ids(media)).not.toContain("copy-image");
    const picture = browserContextMenuTemplate({ ...BARE, hasImageContents: true, srcURL: "https://example.com/cat.png" }, {});
    expect(ids(picture)).toEqual(["open-image-new-tab", "copy-image", "save-image-as", "—", "view-source", "inspect"]);
    expect(find(picture, "save-image-as").value).toBe("https://example.com/cat.png");
  });

  test("a link around an image offers both, in that order", () => {
    const template = browserContextMenuTemplate(
      { ...BARE, linkURL: "https://example.com/other", hasImageContents: true, srcURL: "https://example.com/cat.png" },
      {},
    );
    expect(ids(template)).toEqual([
      "open-link-new-tab",
      "copy-link",
      "—",
      "open-image-new-tab",
      "copy-image",
      "save-image-as",
      "—",
      "view-source",
      "inspect",
    ]);
  });

  test("a selection copies and searches, and the label quotes it on one line", () => {
    const template = browserContextMenuTemplate({ ...BARE, selectionText: "  quantum\n  foam  " }, {});
    expect(ids(template)).toEqual(["copy", "search-web", "—", "view-source", "inspect"]);
    // The VALUE is the selection as typed; only the LABEL is flattened.
    expect(find(template, "search-web").value).toBe("quantum\n  foam");
    expect(find(template, "search-web").label).toBe("Search the web for “quantum foam”");
  });

  test("a long selection is ellipsized rather than widening the menu", () => {
    const long = "the quick brown fox jumps over the lazy dog";
    const label = find(browserContextMenuTemplate({ ...BARE, selectionText: long }, {}), "search-web").label;
    expect(label).toBe("Search the web for “the quick brown fox jump…”");
    // Whole, though, is what actually gets searched.
    expect(find(browserContextMenuTemplate({ ...BARE, selectionText: long }, {}), "search-web").value).toBe(long);
  });

  test("whitespace is not a selection", () => {
    expect(ids(browserContextMenuTemplate({ ...BARE, selectionText: "   \n " }, { canGoBack: true }))).toContain("back");
  });
});

describe("an editable field", () => {
  test("offers the edit verbs, enabled from Chromium's own flags", () => {
    const template = browserContextMenuTemplate(
      { ...BARE, isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } },
      {},
    );
    expect(ids(template)).toEqual(["cut", "copy", "paste", "select-all", "—", "view-source", "inspect"]);
    expect(find(template, "cut").enabled).toBe(false);
    expect(find(template, "copy").enabled).toBe(false);
    expect(find(template, "paste").enabled).toBe(true);
  });

  test("a flag Chromium did not send reads as enabled, never as greyed out", () => {
    const template = browserContextMenuTemplate({ ...BARE, isEditable: true }, {});
    for (const id of ["cut", "copy", "paste", "select-all"]) expect(find(template, id).enabled).toBe(true);
  });

  test("spelling suggestions come FIRST, one row each, carrying the word", () => {
    const template = browserContextMenuTemplate(
      {
        ...BARE,
        isEditable: true,
        misspelledWord: "recieve",
        dictionarySuggestions: ["receive", "relieve"],
        editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
      },
      {},
    );
    expect(ids(template)).toEqual([
      "replace-misspelling",
      "replace-misspelling",
      "—",
      "cut",
      "copy",
      "paste",
      "select-all",
      "—",
      "view-source",
      "inspect",
    ]);
    const [first, second] = template.filter((entry) => entry.id === "replace-misspelling");
    expect([first.label, first.value]).toEqual(["receive", "receive"]);
    expect([second.label, second.value]).toEqual(["relieve", "relieve"]);
  });

  test("a misspelling with nothing to suggest SAYS SO rather than going quiet", () => {
    // A word silently missing its correction reads as a spell-checker that is
    // switched off — which is a different thing, and not the true one.
    const template = browserContextMenuTemplate({ ...BARE, isEditable: true, misspelledWord: "zzxq", dictionarySuggestions: [] }, {});
    const none = find(template, "no-spelling-suggestions");
    expect(none).toMatchObject({ label: "No spelling suggestions", enabled: false });
    expect(ids(template)[0]).toBe("no-spelling-suggestions");
  });

  test("a long suggestion list is capped", () => {
    const many = Array.from({ length: 12 }, (_, index) => `word${index}`);
    const template = browserContextMenuTemplate({ ...BARE, isEditable: true, misspelledWord: "wrd", dictionarySuggestions: many }, {});
    expect(template.filter((entry) => entry.id === "replace-misspelling")).toHaveLength(SPELLING_SUGGESTION_LIMIT);
  });

  test("a correctly-spelled editable field gets no spelling section at all", () => {
    const template = browserContextMenuTemplate({ ...BARE, isEditable: true, dictionarySuggestions: ["stale"] }, {});
    expect(ids(template)[0]).toBe("cut");
  });
});

describe("the template is data the manager can actually run", () => {
  test("every id the fold can emit is handled in browser-manager's one switch", () => {
    // THE FAILURE THIS PREVENTS: a row added here and nowhere else is a menu
    // item that opens, highlights, and does nothing at all.
    const source = fs.readFileSync(path.join(__dirname, "browser-context-menu.js"), "utf8");
    const emitted = new Set([...source.matchAll(/\brow\("([a-z-]+)"/g)].map((match) => match[1]));
    expect(emitted.size).toBeGreaterThan(10);
    const manager = fs.readFileSync(path.join(__dirname, "browser-manager.js"), "utf8");
    const handled = new Set([...manager.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]));
    // The disabled row is the one that deliberately does nothing.
    expect([...emitted].filter((id) => id !== "no-spelling-suggestions" && !handled.has(id))).toEqual([]);
  });

  test("every row is either a separator or a complete, labelled item", () => {
    const template = browserContextMenuTemplate(
      { ...BARE, linkURL: "https://example.com/other", isEditable: true, misspelledWord: "recieve", dictionarySuggestions: ["receive"] },
      { canGoBack: true },
    );
    for (const entry of template) {
      if (entry.type === "separator") {
        expect(Object.keys(entry)).toEqual(["type"]);
        continue;
      }
      expect(typeof entry.id).toBe("string");
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.enabled).toBe("boolean");
    }
    // Never a leading, trailing or doubled separator — an empty section is
    // dropped whole rather than leaving a rule with nothing under it.
    expect(template[0].type).not.toBe("separator");
    expect(template.at(-1).type).not.toBe("separator");
    expect(ids(template).join(",")).not.toContain("—,—");
  });
});
