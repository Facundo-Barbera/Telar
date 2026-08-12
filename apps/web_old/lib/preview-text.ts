// Markdown reads as noise in a one-line glimpse — "**done**" is not done, and
// a stray "> " turns a quote into an arrow. Every list surface shows the
// preview in a plain element, so the markers buy nothing and the flatten
// happens at the SOURCE (store.ts's previewOf), before the character cap, so
// the cap counts visible characters only.
//
// A LEXICAL STRIP, NOT A PARSER, deliberately: the transcript renderer owns
// real markdown; this only removes the marks a one-liner actually meets
// (fences, emphasis, inline code, links, and the line-anchored heading /
// quote / bullet prefixes). Line-anchored rules run FIRST — the caller
// collapses whitespace afterwards, which destroys the line starts they key on.
//
// Underscore emphasis is stripped only at word edges (lookarounds), because
// `snake_case_names` are ordinary text in this product's replies and
// `_fold_` inside one is not emphasis. Asterisks carry no such ambiguity.
export function previewPlainText(md: string): string {
  return (
    md
      // fence lines: drop the ``` and its language tag, keep the code inside
      .replace(/^[ \t]*```[^\n]*$/gm, " ")
      // line-anchored markers: headings, blockquotes, bullets, ordered lists
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "")
      // images then links, in that order — an image is a link with a bang
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // inline marks: code, bold/italic (asterisk), strikethrough
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      // underscore emphasis only at word edges — never inside snake_case
      .replace(/(?<![\w])_{1,3}([^_]+?)_{1,3}(?![\w])/g, "$1")
      // unbalanced leftovers (a cap can cut an inline span in half upstream,
      // and a lone backtick is pure noise either way)
      .replace(/`+/g, "")
  );
}
