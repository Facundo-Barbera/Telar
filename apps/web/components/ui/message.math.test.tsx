/**
 * WHAT A MESSAGE DOES WITH DOLLAR SIGNS.
 *
 * Rendered, not pinned to source: `MessageResponse` is put through
 * `renderToStaticMarkup` and the HTML is read, so these assert the behaviour a
 * reader gets rather than the props the component happens to pass. That matters
 * most for the two halves that are easy to get backwards — an equation must
 * typeset, and money must not.
 *
 * The two `STUDY_GUIDE` equations are the reported case, imported from the dev
 * gallery so the fixture and the test cannot drift apart.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "@/components/ui/message";
import { STUDY_GUIDE } from "@/app/dev/math-samples/samples";

const render = (markdown: string, streaming = false) =>
  renderToStaticMarkup(<MessageResponse streaming={streaming}>{markdown}</MessageResponse>);

/** The TeX KaTeX kept for copy/accessibility, one entry per equation it typeset. */
const sources = (html: string): string[] =>
  [...html.matchAll(/<annotation encoding="application\/x-tex">([\s\S]*?)<\/annotation>/g)].map(([, tex]) =>
    tex.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#x27;", "'").replaceAll("&quot;", '"'),
  );

const displays = (html: string) => (html.match(/katex-display/g) ?? []).length;
const errors = (html: string) => (html.match(/katex-error/g) ?? []).length;
/**
 * Everything outside a tag — what a reader actually sees, minus the MathML
 * mirror. `<annotation>` holds the verbatim TeX and `<math>` the spoken form;
 * both are drawn by nothing (KaTeX clips the mirror), so counting their text as
 * visible would make "the delimiters are gone" unfalsifiable.
 */
const text = (html: string) =>
  html.replaceAll(/<span class="katex-mathml">[\s\S]*?<\/span>/g, "").replaceAll(/<[^>]*>/g, "");

const RETURN_TEX = "R_t = \\frac{P_t - P_{t-1}}{P_{t-1}} = \\frac{P_t}{P_{t-1}} - 1";
const TOTAL_TEX = "1 + R_{total} = (1+R_1)(1+R_2)\\cdots(1+R_T)";

describe("the reported study guide", () => {
  const html = render(STUDY_GUIDE);

  test("both equations typeset, from the exact TeX that was written", () => {
    expect(sources(html)).toContain(RETURN_TEX);
    expect(sources(html)).toContain(TOTAL_TEX);
    expect(errors(html)).toBe(0);
  });

  test("no dollar sign survives as a delimiter", () => {
    expect(text(html)).not.toContain("$$");
    expect(text(html)).not.toContain("\\frac");
  });

  test("each equation on its own line becomes DISPLAY math, not cramped inline", () => {
    // The two standalone `$$…$$` lines; the `$$T$$` inside the sentence is the
    // third equation here and must stay inline.
    expect(displays(html)).toBe(2);
    expect(sources(html)).toContain("T");
  });

  test("the prose around them is untouched", () => {
    expect(text(html)).toContain("A simple return measures one period");
    expect(text(html)).toContain("which is why a 50% loss needs a 100% gain to undo.");
    expect(html).toContain('data-streamdown="strong">simple return<');
  });
});

describe("display and inline", () => {
  test("`$$` across its own lines is display math", () => {
    const html = render("$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$");
    expect(displays(html)).toBe(1);
    expect(errors(html)).toBe(0);
  });

  test("`$$…$$` inside a sentence stays inline", () => {
    const html = render("The drift $$\\mu$$ and the volatility $$\\sigma$$ set the shape.");
    expect(displays(html)).toBe(0);
    expect(sources(html)).toEqual(["\\mu", "\\sigma"]);
    expect(text(html)).toContain("The drift ");
  });

  test("fractions, sub/superscripts, Greek, matrices and aligned all typeset", () => {
    const cases = [
      "$$\n\\frac{a}{b}\n$$",
      "$$\nx_i^{2n}\n$$",
      "$$\n\\alpha\\beta\\Gamma\\Omega\\sigma\n$$",
      "$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$",
      "$$\n\\begin{aligned} y &= mx + b \\\\ z &= y^2 \\end{aligned}\n$$",
    ];
    for (const markdown of cases) {
      const html = render(markdown);
      expect(errors(html)).toBe(0);
      expect(displays(html)).toBe(1);
    }
  });

  test("an equation carries a MathML mirror for a screen reader", () => {
    expect(render("$$\nE = mc^2\n$$")).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
  });
});

describe("dollars that are not math", () => {
  test("prices in prose stay prices", () => {
    const html = render("The plan costs $5 a month, or $10 with the add-on — a $5 saving over $15.");
    expect(sources(html)).toEqual([]);
    expect(text(html)).toContain("$5 a month, or $10 with the add-on");
    expect(text(html)).toContain("$15");
  });

  test("escaped dollars render literally and typeset nothing", () => {
    const html = render("Literally \\$\\$not math\\$\\$, and a lone \\$99.");
    expect(sources(html)).toEqual([]);
    expect(text(html)).toContain("$$not math$$");
    expect(text(html)).toContain("$99");
  });

  test("a fenced block keeps its TeX as source", () => {
    const html = render("```md\n$$E = mc^2$$\n```");
    expect(sources(html)).toEqual([]);
    expect(html).toContain('data-streamdown="code-block"');
    expect(text(html)).toContain("$$E = mc^2$$");
  });

  test("inline code keeps its TeX as source", () => {
    const html = render("Write `$$E = mc^2$$` to typeset it.");
    expect(sources(html)).toEqual([]);
    expect(html).toContain('data-streamdown="inline-code"');
    expect(text(html)).toContain("$$E = mc^2$$");
  });
});

describe("half-arrived and broken TeX", () => {
  test("every prefix of a streaming answer renders without throwing", () => {
    const full = `Given the growth factors,\n\n$$\n${TOTAL_TEX}\n$$\n\nthe total compounds.`;
    for (let end = 1; end <= full.length; end += 1) {
      const html = render(full.slice(0, end), true);
      // A delimiter must never be left on screen as literal text, at any prefix.
      expect(text(html)).not.toContain("$$");
    }
  });

  test("the completed stream is the same equation as the settled message", () => {
    const markdown = `$$\n${TOTAL_TEX}\n$$`;
    expect(sources(render(markdown, true))).toEqual([TOTAL_TEX]);
    expect(sources(render(markdown, false))).toEqual([TOTAL_TEX]);
    expect(displays(render(markdown, false))).toBe(1);
  });

  test("TeX that cannot parse shows its own source instead of throwing", () => {
    const html = render("$$\\frac{1}{\\unknownmacro{x}$$");
    expect(errors(html)).toBe(1);
    expect(text(html)).toContain("\\frac{1}{\\unknownmacro{x}");
    expect(text(html)).not.toContain("$$");
  });
});

/**
 * KaTeX's HTML extension (`\href`, `\htmlClass`, `\htmlId`, `\htmlData`) is what
 * would turn a model's TeX into markup it chose. rehype-katex leaves `trust`
 * false and `strict` at "warn", so each of those macros is refused and printed
 * as its own name. The macro's ARGUMENTS still appear in the `<annotation>` —
 * that element is the verbatim TeX source, kept for copy and for assistive
 * technology, and is inert by construction. These assert on the markup instead.
 */
describe("TeX is not a way to inject markup", () => {
  /** The rendered tree with the verbatim-source annotations cut out. */
  const markup = (html: string) => html.replaceAll(/<annotation[\s\S]*?<\/annotation>/g, "");

  test("`\\href` mints no link", () => {
    const html = markup(render("$$\\href{javascript:alert(1)}{click}$$"));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("\\href"); // refused in place, printed as its own name
  });

  test("`\\htmlClass` and `\\htmlData` set no attributes", () => {
    const html = markup(render("$$\\htmlClass{evil}{x}\\htmlData{foo=bar}{y}$$"));
    expect(html).not.toContain("evil");
    expect(html).not.toContain("data-foo");
  });

  test("raw HTML in a message is still text, not markup", () => {
    const html = render('Before <img src="x" onerror="alert(1)"> after $$x^2$$');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(sources(html)).toEqual(["x^2"]);
  });
});

describe("the wiring", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const source = fs.readFileSync(path.join(here, "message.tsx"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const layout = fs.readFileSync(path.join(here, "..", "..", "app", "layout.tsx"), "utf8");
  const css = fs.readFileSync(path.join(here, "..", "..", "app", "globals.css"), "utf8").replaceAll(/\/\*[\s\S]*?\*\//g, "");

  test("math is the library's plugin, and the stylesheet it needs is loaded once", () => {
    expect(source).toContain('from "@streamdown/math"');
    expect(layout).toContain('import "katex/dist/katex.min.css";');
  });

  test("single-dollar math stays off — the currency case depends on the default", () => {
    expect(source).not.toContain("singleDollarTextMath");
    expect(source).not.toContain("createMathPlugin");
  });

  test("a caller's plugins cannot silently drop math", () => {
    const html = renderToStaticMarkup(
      <MessageResponse rehypePlugins={[]} plugins={{}}>
        {`$$\n${RETURN_TEX}\n$$`}
      </MessageResponse>,
    );
    expect(sources(html)).toEqual([RETURN_TEX]);
  });

  test("a wide equation gets a scroll port rather than a clipped tail", () => {
    expect(css).toMatch(/\.telar-markdown \.katex-display \{[^}]*overflow-x: auto/);
  });
});
