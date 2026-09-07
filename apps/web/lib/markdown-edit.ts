/**
 * THE MARKDOWN TOOLBAR'S ARITHMETIC, free of the DOM.
 *
 * The file viewer's markdown mode grows a small formatting toolbar — bold,
 * italic, code, link, heading, list, quote — and every button is the same
 * operation: take the text and the selection, produce new text and a new
 * selection. That is a pure function, so it lives here where `bun test` can
 * reach it without a browser (this app has no DOM harness — the same reason
 * right-panel.tsx exports its folds). The component's whole job is to read
 * the textarea, call this, and write both halves back.
 *
 * TOGGLES, NOT STAMPS. Pressing Bold on already-bold text unwraps it —
 * anything else turns a second press into `****text****`. The check is exact
 * and local (the selection's own edges, or the markers just outside them);
 * this is a toolbar, not a parser, and it must never reformat text the user
 * did not select.
 */

export type MarkdownEditAction = "bold" | "italic" | "strike" | "code" | "link" | "heading" | "bullet" | "quote";

export type MarkdownEdit = {
  text: string;
  /** Where the selection lands afterwards — kept ON the affected text, so a
   *  second press of the same button finds it and toggles back. */
  selectionStart: number;
  selectionEnd: number;
};

const WRAPPERS: Partial<Record<MarkdownEditAction, { marker: string; placeholder: string }>> = {
  bold: { marker: "**", placeholder: "bold text" },
  italic: { marker: "_", placeholder: "italic text" },
  strike: { marker: "~~", placeholder: "struck text" },
  code: { marker: "`", placeholder: "code" },
};

const LINE_PREFIXES: Partial<Record<MarkdownEditAction, string>> = {
  heading: "## ",
  bullet: "- ",
  quote: "> ",
};

function wrap(text: string, start: number, end: number, marker: string, placeholder: string): MarkdownEdit {
  const selected = text.slice(start, end);
  // Unwrap when the selection ITSELF carries the markers ("**bold**" selected
  // whole) or sits just inside them ("bold" selected within "**bold**").
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    return { text: text.slice(0, start) + inner + text.slice(end), selectionStart: start, selectionEnd: start + inner.length };
  }
  const before = text.slice(Math.max(0, start - marker.length), start);
  const after = text.slice(end, end + marker.length);
  if (before === marker && after === marker) {
    return {
      text: text.slice(0, start - marker.length) + selected + text.slice(end + marker.length),
      selectionStart: start - marker.length,
      selectionEnd: end - marker.length,
    };
  }
  const content = selected || placeholder;
  return {
    text: text.slice(0, start) + marker + content + marker + text.slice(end),
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + content.length,
  };
}

/**
 * Line operations touch EVERY line the selection crosses, caret included —
 * a caret parked mid-line means "this line", the way every editor reads it.
 */
function prefixLines(text: string, start: number, end: number, prefix: string): MarkdownEdit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndBreak = text.indexOf("\n", end);
  const lineEnd = lineEndBreak === -1 ? text.length : lineEndBreak;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  // A toggle over a MIXED block adds rather than strips: making everything
  // uniform is a legible outcome, while stripping only some lines is not.
  const allPrefixed = lines.every((line) => line.startsWith(prefix) || line.trim() === "");
  const changed = lines
    .map((line) => {
      if (line.trim() === "") return line;
      if (allPrefixed) return line.slice(prefix.length);
      // Headings replace rather than stack: "# x" through "###### x" becomes
      // the toolbar's level, never "## # x".
      const cleaned = prefix === LINE_PREFIXES.heading ? line.replace(/^#{1,6}\s+/, "") : line;
      return prefix + cleaned;
    })
    .join("\n");
  return {
    text: text.slice(0, lineStart) + changed + text.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + changed.length,
  };
}

function link(text: string, start: number, end: number): MarkdownEdit {
  const selected = text.slice(start, end);
  const label = selected || "link text";
  const insertion = `[${label}](url)`;
  // The URL is what remains to be typed, so it is what stays selected.
  const urlStart = start + 1 + label.length + 2;
  return {
    text: text.slice(0, start) + insertion + text.slice(end),
    selectionStart: urlStart,
    selectionEnd: urlStart + 3,
  };
}

export function applyMarkdownEdit(text: string, selectionStart: number, selectionEnd: number, action: MarkdownEditAction): MarkdownEdit {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const wrapper = WRAPPERS[action];
  if (wrapper) return wrap(text, start, end, wrapper.marker, wrapper.placeholder);
  const prefix = LINE_PREFIXES[action];
  if (prefix) return prefixLines(text, start, end, prefix);
  return link(text, start, end);
}
