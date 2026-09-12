// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { PackagesPanel } from "./packages-panel";

/**
 * THE TWO SECTIONS THAT USED TO BYPASS THE ROW GRAMMAR.
 *
 * Both hand-rolled `Row`'s anatomy — a bold div for the label, a muted `text-xs`
 * one for the hint, controls pushed right — which is the duplication the shared
 * grammar exists to end. What is pinned here is that they are on `Row` now, and
 * that the port did not quietly change what each surface offers: the panel is
 * used in TWO scopes and the looks row keeps a control live that a blanket
 * `unavailable` would have killed.
 */
const looks = readFileSync(new URL("./looks-section.tsx", import.meta.url), "utf8");
const packages = readFileSync(new URL("./packages-panel.tsx", import.meta.url), "utf8");

test("the packages fields are Rows with names, not unlabelled blocks", () => {
  // Server render, so no fetch has resolved — this is the first paint, which is
  // exactly where an unlabelled input said nothing at all.
  const html = renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />);
  expect(html).toContain("Install packages");
  // A real Row: it carries the derived anchor and the reserved revert slot, so
  // search can reach it and it measures like every other field.
  expect(html).toContain('id="settings-row-environment-install-packages"');
  expect(html).toContain('<span class="flex size-3 shrink-0 items-center justify-center">');
});

test("with no environment resolved, the install field says so instead of sitting dead", () => {
  const html = renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />);
  // The control was already `disabled`; what was missing was the reason. `Row`
  // supplies both now, from the one prop.
  expect(html).toContain("No Python environment was resolved for this project.");
  expect(html).toContain("inert=");
});

test("the session's narrow column keeps the rows and drops the group frame", () => {
  // The labelling is the point of the port, and it lives on the rows — so
  // `dense` may not be allowed to opt out of it, only out of the heading.
  const dense = renderToStaticMarkup(<PackagesPanel scope={{ sessionId: "session_a" }} dense />);
  expect(dense).toContain("Install packages");
  expect(dense).not.toContain("<h4");
  const wide = renderToStaticMarkup(<PackagesPanel scope={{ projectId: "project_a" }} />);
  expect(wide).toContain("<h4");
});

test("both sections import the shared grammar rather than restating it", () => {
  expect(packages).toContain('from "./settings-shell"');
  expect(looks).toContain('from "./settings-shell"');
  // PanelRow is gone from looks-section: the host row was its only user there.
  expect(looks).not.toContain("PanelRow");
});

test("the host-look row keeps Retry live when there is nothing to follow", () => {
  /**
   * The regression this guards: `unavailable` takes the whole control column
   * inert as a unit, and this row's column holds both the Follow switch (which
   * SHOULD be dead with no published look) and Retry (which is the entire point
   * of the failed and empty states). The switch refuses for itself instead.
   */
  expect(looks).not.toContain("unavailable=");
  expect(looks).toContain("disabled={!ready && !following}");
  expect(looks).toContain('disabled={state.status === "loading"}');
});
