// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Row, ToggleRow } from "./settings-shell";

/**
 * ROW ANATOMY v2 — the three parts a caller can now reach.
 *
 * Rendered rather than read from source, because each of these is a claim about
 * what arrives in the DOM: a control that is only VISUALLY dimmed still takes a
 * click, and a revert slot that is only DOCUMENTED as reserved still shifts the
 * row. Neither would fail a test that read the props back.
 */

test("an unavailable control is inert, and the reason stands in for the hint", () => {
  const html = renderToStaticMarkup(
    <Row
      label="LaTeX"
      hint="Compile documents from this project's checkout."
      unavailable={{ reason: "This plugin did not start." }}
      control={<button type="button">Configure</button>}
    />,
  );
  // `inert` is the whole point: dimming alone leaves the button clickable and
  // in the tab order, which is a control that lies.
  expect(html).toContain("inert=");
  expect(html).toContain("This plugin did not start.");
  // The hint is REPLACED, not joined — otherwise the reader gets a sentence
  // about how the setting behaves under the sentence saying it does not apply.
  expect(html).not.toContain("Compile documents");
  // And the control is still THERE, so the reader can see what the setting is.
  expect(html).toContain("Configure");
});

test("an available row leaves its control alone", () => {
  const html = renderToStaticMarkup(<Row label="LaTeX" hint="Compile documents." control={<button type="button">Configure</button>} />);
  expect(html).not.toContain("inert=");
  expect(html).toContain("Compile documents.");
});

test("status reads beside the label, not inside the control", () => {
  const html = renderToStaticMarkup(<Row label="Engine" status={<span>Not answering</span>} control={<button type="button">Restart</button>} />);
  // Before the control in document order — a row's state is read with its name.
  expect(html.indexOf("Not answering")).toBeGreaterThan(-1);
  expect(html.indexOf("Not answering")).toBeLessThan(html.indexOf("Restart"));
});

test("the revert slot is reserved whether or not the arrow is in it", () => {
  // The same row, the only difference being whether the value is default. The
  // markup around the slot has to be identical, or the label moves when a
  // reader changes the setting they are looking at.
  const at = (html: string) => html.indexOf('<span class="flex size-3 shrink-0 items-center justify-center">');
  const plain = renderToStaticMarkup(<Row label="Model" control={<span>gpt</span>} />);
  const reverting = renderToStaticMarkup(<Row label="Model" onRevert={() => undefined} control={<span>gpt</span>} />);
  expect(at(plain)).toBeGreaterThan(-1);
  expect(at(reverting)).toBe(at(plain));
  expect(plain).not.toContain("Revert to the default");
  expect(reverting).toContain("Revert to the default");
});

test("a toggle row carries status and unavailable through to the Row", () => {
  const html = renderToStaticMarkup(
    <ToggleRow
      label="Name sessions"
      status={<span>Beta</span>}
      checked={false}
      onCheckedChange={() => undefined}
      unavailable={{ reason: "No provider is configured to name them." }}
    />,
  );
  expect(html).toContain("Beta");
  expect(html).toContain("inert=");
  expect(html).toContain("No provider is configured to name them.");
});
