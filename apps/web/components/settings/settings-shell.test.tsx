// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Row, SettingsGroup, ToggleRow } from "./settings-shell";

/**
 * ROW ANATOMY v2, AND THE ANCHOR EVERY SEARCH RESULT AIMS AT.
 *
 * Rendered rather than read from source, because every claim here is a claim
 * about what reaches the DOM: a control that is only VISUALLY dimmed still
 * takes a click, a revert slot that is only DOCUMENTED as reserved still
 * shifts the row, and an id the index computes but the row does not stamp is a
 * result that navigates and then lands nowhere. None of the three would fail a
 * test that read the props back.
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

test("a group draws one card, with its rows hairlined inside it", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Organization">
      <Row label="Project grouping" hint="Combine matching repositories across environments." />
      <Row label="Auto-settle merged threads" hint="Settle a thread when its pull request merges." />
    </SettingsGroup>,
  );
  // ONE card around BOTH rows, not one per row — the group is the object.
  // The arbitrary variant arrives HTML-escaped in a server render — matched as
  // it actually reaches the DOM rather than as it is written in the source.
  const card = 'class="divide-y divide-border/60 rounded-xl border border-border bg-card shadow-sm [&amp;&gt;*]:px-4"';
  expect(html).toContain(card);
  expect(html.split(card).length - 1).toBe(1);
  expect(html).toContain("Project grouping");
  expect(html).toContain("Auto-settle merged threads");
});

test("the group's title is a caption ABOVE the card, and quieter than the rows it governs", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Organization">
      <Row label="Project grouping" />
    </SettingsGroup>,
  );
  // Outside the card: the caption's markup closes before the card opens.
  expect(html.indexOf("Organization")).toBeLessThan(html.indexOf("rounded-xl border border-border bg-card"));
  // And recessive — a section header must not outweigh the row titles under it.
  expect(html).toContain("text-foreground/70");
  expect(html).not.toContain("text-base font-semibold");
});

test("a group with no title is still a card, so a captionless group is not a loose list", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup>
      <Row label="Browser profiles" />
    </SettingsGroup>,
  );
  expect(html).toContain("rounded-xl border border-border bg-card");
  expect(html).not.toContain("<h4");
});

test("a row inside a group carries the derived anchor and takes focus", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Settling">
      <Row label="Settle quiet sessions" hint="Off means nothing leaves the list on its own." />
    </SettingsGroup>,
  );
  // No pane around it here, so the id is group + label — the same derivation
  // the shell completes with its selected pane.
  expect(html).toContain('id="settings-row-settling-settle-quiet-sessions"');
  expect(html).toContain('tabindex="-1"');
});

test("the group's title only names rows when it is a plain string", () => {
  // "Telar's servers" is spliced from a project name; a row under it must not
  // take an anchor that moves when the project is renamed.
  const html = renderToStaticMarkup(
    <SettingsGroup title={<span>Acme&apos;s servers</span>}>
      <Row label="Add a server" />
    </SettingsGroup>,
  );
  expect(html).toContain('id="settings-row-add-a-server"');
});

test("an explicit id wins, for labels that are not text", () => {
  const html = renderToStaticMarkup(<Row id="settings-row-paired-device" label={<strong>iPhone</strong>} />);
  expect(html).toContain('id="settings-row-paired-device"');
});

test("a toggle row is a destination too", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Generated text">
      <ToggleRow label="Name sessions" checked={false} onCheckedChange={() => undefined} />
    </SettingsGroup>,
  );
  expect(html).toContain('id="settings-row-generated-text-name-sessions"');
});
