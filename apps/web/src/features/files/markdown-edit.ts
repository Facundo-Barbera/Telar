
export type MarkdownEditAction = "bold" | "italic" | "strike" | "code" | "link" | "heading" | "bullet" | "quote";

export type MarkdownEdit = {
  text: string;
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

function prefixLines(text: string, start: number, end: number, prefix: string): MarkdownEdit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndBreak = text.indexOf("\n", end);
  const lineEnd = lineEndBreak === -1 ? text.length : lineEndBreak;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const allPrefixed = lines.every((line) => line.startsWith(prefix) || line.trim() === "");
  const changed = lines
    .map((line) => {
      if (line.trim() === "") return line;
      if (allPrefixed) return line.slice(prefix.length);
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
