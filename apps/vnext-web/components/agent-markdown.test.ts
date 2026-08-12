/**
 * What streamdown actually emits, pinned.
 *
 * WHY THIS TEST EXISTS. The cockpit has no Tailwind and streamdown assumes one:
 * its stylesheet is 499 bytes of keyframes and every visual class in its output
 * is a Tailwind utility that does nothing here. That is fine — `app/globals.css`
 * styles it against `data-streamdown` hooks instead — but it means the STRUCTURE
 * is the contract between the library and our stylesheet, and structure is
 * exactly what a screenshot cannot assert and a typecheck cannot see.
 *
 * The specific defect: a fenced code block rendered as one run-on line. Two CSS
 * fixes aimed at `white-space` failed before rendering the component and reading
 * the HTML showed why — there are no newlines in the output at all. Each line is
 * its own `<span class="block">`, and `block` is a Tailwind utility. Nothing but
 * looking at the markup could have found that.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown } from "./agent-markdown";

const render = (text: string, streaming?: boolean) =>
  renderToStaticMarkup(AgentMarkdown({ text, streaming }) as never);

test("a fenced code block emits one element per line, which the stylesheet must un-inline", () => {
  const html = render("```ts\nconst a = 1;\nconst b = 2;\n```\n");
  const body = html.slice(html.indexOf('data-streamdown="code-block-body"'));

  // The load-bearing structural facts our CSS depends on.
  expect(html).toContain('data-streamdown="code-block"');
  expect(body).toContain("<code");
  // ONE SPAN PER LINE and NO newline characters between them: `white-space: pre`
  // has nothing to act on, so `code > span { display: block }` is what makes the
  // block render as three lines rather than one.
  expect(body).not.toContain("const a = 1;\nconst b = 2;");
  const lineSpans = body.split("<span").filter((chunk) => chunk.includes("const ")).length;
  expect(lineSpans).toBeGreaterThanOrEqual(2);
});

test("the cockpit's own class reaches the root, so every rule below it applies", () => {
  // `className` is merged with streamdown's own utilities rather than replacing
  // them; if that ever stops being true, the entire stylesheet silently detaches.
  expect(render("hello")).toContain("vnext-markdown");
});

test("lists, inline code and emphasis carry the hooks the stylesheet targets", () => {
  const html = render("- one `code` and **bold**\n");
  expect(html).toContain('data-streamdown="unordered-list"');
  expect(html).toContain('data-streamdown="list-item"');
  expect(html).toContain('data-streamdown="inline-code"');
  expect(html).toContain('data-streamdown="strong"');
});

test("an empty message renders nothing rather than an empty block", () => {
  expect(render("")).toBe("");
});
