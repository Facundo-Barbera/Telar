// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MainFileSelect } from "./latex-section";

/**
 * THE SENTINEL IS NOT A LABEL (#352) — the same bug #318 fixed for the scope
 * select, found again on this page. "No default" is carried as `__none`, and
 * base-ui's `Select.Value` renders the raw VALUE when nothing maps it to a
 * label, so the trigger read `__none` while the list beside it read "No
 * default" the whole time.
 */
test("with no default chosen the trigger reads 'No default', never the sentinel", () => {
  const html = renderToStaticMarkup(<MainFileSelect candidates={["paper/main.tex"]} onPick={() => {}} />);
  // The trigger's own value element. base-ui also renders a hidden form input
  // carrying the real value, which is right — so this pins the visible span.
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">No default<');
});

test("with a document chosen the trigger reads the path", () => {
  const html = renderToStaticMarkup(<MainFileSelect value="paper/main.tex" candidates={["paper/main.tex"]} onPick={() => {}} />);
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">paper/main.tex<');
});
