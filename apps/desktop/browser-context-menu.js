"use strict";

// THE PAGE'S RIGHT-CLICK MENU, AS A PURE FOLD (issue #423).
//
// Chromium hands `context-menu` a `params` object describing what was under the
// pointer — a link, an image, a selection, an editable field, a misspelled word
// — and every browser turns that into the same handful of rows. This file is
// that turn, and nothing else: params in, a plain array of rows out. No Electron,
// no Node, no `this` — so the decision of WHAT the menu says is testable without
// a display, and browser-manager.js is left with only the doing.
//
// A ROW IS DATA, NOT A CALLBACK. Each carries an `id` (what to do), a `label`
// (what it says), `enabled`, and — where the doing needs a payload the params
// alone do not spell — a `value`: the link to open, the word to substitute, the
// text to search for. The manager owns one switch over those ids; adding a row
// here without teaching it there is a row that does nothing, which is why both
// halves are named in the same test.
//
// THE SECTIONS FOLLOW CHROME'S, including the part people notice only when it is
// missing: Back / Forward / Reload appear on the PAGE ITSELF, not over a link or
// a selection. Chrome does this because a context menu is about the thing you
// right-clicked, and three disabled-looking navigation rows above "Copy Link" is
// a menu that has forgotten what it was asked. Inspect and View Page Source are
// the two that are always there.

/** How many of Chromium's spelling suggestions are offered. Its list can run
 *  long; a context menu that is mostly one misspelled word is not usable. */
const SPELLING_SUGGESTION_LIMIT = 5;

/** A selection quoted into a menu label. A row is one line wide and the whole
 *  selection can be a paragraph. */
const SELECTION_LABEL_LIMIT = 24;

const SEPARATOR = { type: "separator" };

function row(id, label, { enabled = true, value } = {}) {
  const entry = { id, label, enabled };
  if (value !== undefined) entry.value = value;
  return entry;
}

/** An edit flag Chromium may not have sent. Absent means "no opinion", which
 *  reads as enabled — a menu that greys out Copy because a params object was
 *  built by hand is worse than one that tries and finds nothing to copy. */
function may(flags, name) {
  return flags?.[name] === undefined ? true : Boolean(flags[name]);
}

/** The selection as a menu label says it: one line, bounded, ellipsized. */
function quoteSelection(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > SELECTION_LABEL_LIMIT ? `${flat.slice(0, SELECTION_LABEL_LIMIT)}…` : flat;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : "";
}

/**
 * The rows for one right-click, separators included.
 *
 * `params` is Chromium's context-menu params (the subset this reads:
 * `linkURL`, `srcURL`/`hasImageContents`, `selectionText`, `isEditable`,
 * `editFlags`, `misspelledWord`, `dictionarySuggestions`, `pageURL`).
 * `context` is what the params cannot know: whether this tab's history has
 * anywhere to go.
 */
function browserContextMenuTemplate(params = {}, context = {}) {
  const sections = [];
  const link = nonEmptyString(params.linkURL);
  const image = params.hasImageContents ? nonEmptyString(params.srcURL) : "";
  const selection = String(params.selectionText ?? "").trim();
  const editable = Boolean(params.isEditable);
  const flags = params.editFlags;

  if (link) {
    sections.push([
      row("open-link-new-tab", "Open Link in New Tab", { value: link }),
      row("copy-link", "Copy Link", { value: link }),
    ]);
  }

  if (image) {
    sections.push([
      row("open-image-new-tab", "Open Image in New Tab", { value: image }),
      row("copy-image", "Copy Image"),
      row("save-image-as", "Save Image As…", { value: image }),
    ]);
  }

  if (editable) {
    // SUGGESTIONS FIRST, above Cut/Copy/Paste, because that is where the eye
    // goes and where every spell-checking menu on this platform puts them. A
    // misspelling Chromium has no suggestion for still says so: a word
    // silently missing its correction reads as a spell-checker that is off.
    if (nonEmptyString(params.misspelledWord)) {
      const suggestions = (Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [])
        .filter((word) => nonEmptyString(word))
        .slice(0, SPELLING_SUGGESTION_LIMIT);
      sections.push(
        suggestions.length > 0
          ? suggestions.map((word) => row("replace-misspelling", word, { value: word }))
          : [row("no-spelling-suggestions", "No spelling suggestions", { enabled: false })],
      );
    }
    sections.push([
      row("cut", "Cut", { enabled: may(flags, "canCut") }),
      row("copy", "Copy", { enabled: may(flags, "canCopy") }),
      row("paste", "Paste", { enabled: may(flags, "canPaste") }),
      row("select-all", "Select All", { enabled: may(flags, "canSelectAll") }),
    ]);
  } else if (selection) {
    sections.push([
      row("copy", "Copy", { enabled: may(flags, "canCopy") }),
      row("search-web", `Search the web for “${quoteSelection(selection)}”`, { value: selection }),
    ]);
  }

  // The page itself was right-clicked — nothing on it, the page. This is the
  // only case in which navigating the whole tab is what the gesture meant.
  if (!link && !image && !editable && !selection) {
    sections.push([
      row("back", "Back", { enabled: Boolean(context.canGoBack) }),
      row("forward", "Forward", { enabled: Boolean(context.canGoForward) }),
      row("reload", "Reload"),
    ]);
  }

  // View Page Source only where there is a source to view: `view-source:` is a
  // web-page scheme, and offering it over about:blank or a file the tab is
  // rendering would be a row that opens a tab on an error.
  const pageURL = nonEmptyString(params.pageURL);
  sections.push([
    ...(/^https?:\/\//i.test(pageURL) ? [row("view-source", "View Page Source", { value: pageURL })] : []),
    row("inspect", "Inspect"),
  ]);

  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) => (index === 0 ? section : [SEPARATOR, ...section]));
}

module.exports = { browserContextMenuTemplate, SPELLING_SUGGESTION_LIMIT, SELECTION_LABEL_LIMIT };
