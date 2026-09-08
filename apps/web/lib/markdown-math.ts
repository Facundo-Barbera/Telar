/**
 * TeX in a conversation, and the one thing the library gets wrong for us.
 *
 * The rendering itself is Streamdown's own math plugin (`@streamdown/math`:
 * remark-math for the syntax, rehype-katex + KaTeX for the glyphs), wired in
 * `components/ui/message.tsx`. Nothing here re-implements any of that, and in
 * particular nothing here rewrites the markdown SOURCE — a regex over the text
 * cannot tell a fenced ```` ``` ```` block, an inline `code` span or an escaped
 * `\$` from prose, and would mangle all three.
 *
 * WHAT REMARK-MATH DOES: `$$…$$` written across its own lines is a display
 * equation; `$$…$$` that opens and closes on ONE line is INLINE math wherever
 * it appears — including when that line is the whole paragraph. Single `$…$` is
 * not math at all (`singleDollarTextMath` stays off, so "$5 to $10" is money).
 *
 * WHY THAT ONE CASE NEEDS HELP: models write a standalone equation on a single
 * line, `$$R_t = \frac{P_t - P_{t-1}}{P_{t-1}}$$`, far more often than they
 * spread it over three. Rendered inline it is left-aligned and typeset in TEXT
 * style, which sets a fraction at script size with the numerator and
 * denominator crammed either side of a short rule — legible, but visibly not
 * the equation the author meant.
 *
 * So: a paragraph whose ONLY content is one inline-math node becomes a display
 * one. This runs on the HAST — the parsed tree, after the markdown grammar has
 * already decided what is code and what is prose — so a `$$…$$` inside a fence
 * or a backtick span is not an inline-math node in the first place and is never
 * seen here. A `$$…$$` in the middle of a sentence keeps its siblings, fails
 * the only-child test, and stays inline.
 */

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = HastElement | HastText | { type: string; children?: HastNode[] };
type HastRoot = { type: "root"; children: HastNode[] };

const isElement = (node: HastNode): node is HastElement => node.type === "element";

const classNames = (node: HastElement): string[] => {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/);
  return [];
};

/** Whitespace between block children is the parser's, not the author's. */
const isBlank = (node: HastNode): boolean => node.type === "text" && (node as HastText).value.trim() === "";

/**
 * The node remark-math leaves for inline math: `<code class="language-math
 * math-inline">`. rehype-katex keys off the `math-inline` / `math-display`
 * class, so promoting one is a matter of handing it the other class in the
 * shape the display case already has (`<pre><code>`), which is exactly what a
 * multi-line `$$` block would have produced.
 */
const soleInlineMath = (node: HastNode): HastElement | null => {
  if (!isElement(node) || node.tagName !== "p") return null;
  const content = node.children.filter((child) => !isBlank(child));
  if (content.length !== 1) return null;
  const only = content[0];
  if (!only || !isElement(only) || only.tagName !== "code") return null;
  return classNames(only).includes("math-inline") ? only : null;
};

const promote = (math: HastElement): HastElement => ({
  type: "element",
  tagName: "pre",
  properties: {},
  children: [
    {
      ...math,
      properties: {
        ...math.properties,
        className: classNames(math).map((name) => (name === "math-inline" ? "math-display" : name)),
      },
    },
  ],
});

const walk = (nodes: HastNode[]): HastNode[] =>
  nodes.map((node) => {
    const math = soleInlineMath(node);
    if (math) return promote(math);
    if (isElement(node) && node.children?.length) return { ...node, children: walk(node.children) };
    return node;
  });

/**
 * A rehype plugin, passed to Streamdown as `rehypePlugins`. Streamdown runs
 * caller plugins BEFORE the math plugin's rehype-katex (verified against
 * streamdown 2.5.0's plugin ordering), which is the whole reason this can be a
 * class rewrite rather than a second KaTeX pass.
 */
export const rehypeDisplayStandaloneMath = () => (tree: HastRoot) => {
  tree.children = walk(tree.children);
};
