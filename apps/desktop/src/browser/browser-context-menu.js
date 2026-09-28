"use strict";

const SPELLING_SUGGESTION_LIMIT = 5;

const SELECTION_LABEL_LIMIT = 24;

const SEPARATOR = { type: "separator" };

function row(id, label, { enabled = true, value } = {}) {
  const entry = { id, label, enabled };
  if (value !== undefined) entry.value = value;
  return entry;
}

function may(flags, name) {
  return flags?.[name] === undefined ? true : Boolean(flags[name]);
}

function quoteSelection(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > SELECTION_LABEL_LIMIT ? `${flat.slice(0, SELECTION_LABEL_LIMIT)}…` : flat;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "" ? value : "";
}

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

  if (!link && !image && !editable && !selection) {
    sections.push([
      row("back", "Back", { enabled: Boolean(context.canGoBack) }),
      row("forward", "Forward", { enabled: Boolean(context.canGoForward) }),
      row("reload", "Reload"),
    ]);
  }

  const pageURL = nonEmptyString(params.pageURL);
  sections.push([
    ...(/^https?:\/\//i.test(pageURL) ? [row("view-source", "View Page Source", { value: pageURL })] : []),
    row("inspect", "Inspect"),
  ]);

  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) => (index === 0 ? section : [SEPARATOR, ...section]));
}

module.exports = { browserContextMenuTemplate, SPELLING_SUGGESTION_LIMIT };
