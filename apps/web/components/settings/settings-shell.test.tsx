// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { SlidersHorizontalIcon } from "lucide-react";
import { Row, SettingsGroup, SettingsShell, ToggleRow } from "./settings-shell";

const here = fileURLToPath(new URL(".", import.meta.url));
const source = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8");

const PANES = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon },
  { id: "projects", label: "Projects", icon: SlidersHorizontalIcon },
];

function shell(active = "general") {
  return renderToStaticMarkup(
    <SettingsShell title="Settings" sections={PANES} active={active} onSelect={() => undefined}>
      <SettingsGroup title="Settling">
        <Row label="Settle quiet sessions" />
      </SettingsGroup>
    </SettingsShell>,
  );
}

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

test("a refused write reads under the hint, and does not take its place", () => {
  const html = renderToStaticMarkup(
    <Row
      label="Workspace"
      hint="Sessions share the project's checkout. Two at once will collide."
      error="The engine refused that default."
      control={<span>Project checkout</span>}
    />,
  );
  // BOTH. The old shape swapped the error INTO the hint, which took the
  // explanation away at the moment a reader most wants it.
  expect(html).toContain("Two at once will collide.");
  expect(html).toContain("The engine refused that default.");
  expect(html.indexOf("Two at once will collide.")).toBeLessThan(html.indexOf("The engine refused that default."));
  expect(html).toContain("text-destructive");
  // Announced: nothing on screen moved, because the control still shows what
  // is stored — a screen reader would otherwise be told nothing happened.
  expect(html).toContain('role="alert"');
});

test("a row with no error renders no alert at all", () => {
  const html = renderToStaticMarkup(<Row label="Workspace" hint="Sessions share the project's checkout." />);
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("text-destructive");
});

test("an errored row keeps showing the value the engine still holds", () => {
  // The failure shape this slot exists for: the write was refused, so the
  // control is still on the stored value rather than the one that was asked for.
  const html = renderToStaticMarkup(
    <Row label="Settle quiet sessions" error="The engine refused that window." control={<span data-value="72">72 hours</span>} />,
  );
  expect(html).toContain("72 hours");
  expect(html).toContain("The engine refused that window.");
});

test("a toggle row carries the revert arrow and the error through too", () => {
  const html = renderToStaticMarkup(
    <ToggleRow
      label="Name sessions"
      hint="Replaces the truncated first message."
      checked={false}
      onCheckedChange={() => undefined}
      onRevert={() => undefined}
      error="The engine refused the change."
    />,
  );
  expect(html).toContain("Revert to the default");
  expect(html).toContain("The engine refused the change.");
  expect(html).toContain("Replaces the truncated first message.");
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

test("the header is a breadcrumb saying where this pane sits", () => {
  const html = shell("projects");
  expect(html).toContain('aria-label="Breadcrumb"');
  // Both halves, in order — the shell's own name, then the selected pane.
  expect(html.indexOf(">Settings<")).toBeLessThan(html.indexOf(">Projects<"));
  // The pane is where the reader already is, so it is marked rather than linked.
  expect(html).toContain('aria-current="page"');
});

test("the crumb's first segment is whatever the shell is called, not the word Settings", () => {
  // Project settings mounts the same shell under the project's own name, and a
  // hardcoded "Settings /" there would name a place that pane is not in.
  const html = renderToStaticMarkup(
    <SettingsShell title="Telar" sections={PANES} active="general" onSelect={() => undefined}>
      <SettingsGroup title="Identity">
        <Row label="Name" />
      </SettingsGroup>
    </SettingsShell>,
  );
  expect(html).toContain(">Telar<");
});

test("with nothing registered there is no Restore defaults to press", () => {
  // A pane of facts (This build, Plugins) has no defaults, and an action that
  // did nothing would be worse than none. Sections opt in — see
  // `useRestoreDefaults` — and this render has no section that has.
  expect(shell()).not.toContain("Restore defaults");
});

test("Restore defaults is offered by the sections, not by a table of pane ids", () => {
  /**
   * PINNED AGAINST SOURCE, because the registration happens in an effect and
   * this app renders tests to static markup. What matters is the shape: the
   * header reads a live registry rather than a list of pane ids that would rot
   * beside every section it names, and it runs every registration it holds.
   */
  expect(source).toContain("export function useRestoreDefaults");
  expect(source).toContain("{restorers.length > 0 && (");
  expect(source).toContain("for (const restore of restorers) void restore();");
  // Registered while MOUNTED, which is what scopes it to the active pane.
  expect(source).toContain("return registry.add(() => latest.current());");
});

test("the save bar is gone — every settings row writes on change", () => {
  // The Unsaved badge and Save changes button were props no caller passed and
  // no row honoured; the per-row revert arrow is the affordance now.
  expect(source).not.toContain("Unsaved");
  expect(source).not.toContain("Save changes");
  expect(source).not.toContain("dirty");
});

test("no section smuggles its write failure in through the hint", () => {
  /**
   * `hint={error ?? "…"}` was the shape every save-per-interaction section
   * reached for before `Row` had an error slot, and it is the one this change
   * exists to end: the explanation disappears exactly when the reader has been
   * refused. Checked across the directory rather than per file, because the
   * next section to be written is the one that would reintroduce it.
   */
  const offenders = readdirSync(here)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
    .filter((name) => readFileSync(`${here}${name}`, "utf8").includes("hint={error ??"));
  // Named rather than asserted against the joined source, so a failure says
  // which file to open instead of printing the directory.
  expect(offenders).toEqual([]);
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
  const card = 'class="divide-y divide-border/60 rounded-xl border border-border bg-card shadow-1 [&amp;&gt;*]:px-4"';
  expect(html).toContain(card);
  expect(html.split(card).length - 1).toBe(1);
  expect(html).toContain("Project grouping");
  expect(html).toContain("Auto-settle merged threads");
});

test("the group's title is a caption ABOVE the card, and leads the rows without outgrowing them", () => {
  const html = renderToStaticMarkup(
    <SettingsGroup title="Organization">
      <Row label="Project grouping" />
    </SettingsGroup>,
  );
  // Outside the card: the caption's markup closes before the card opens.
  expect(html.indexOf("Organization")).toBeLessThan(html.indexOf("rounded-xl border border-border bg-card"));
  // #644: WEIGHT AND CONTRAST ARE WHAT MAKE IT A HEADING. Dimmed to
  // `text-foreground/70` it composited to the same grey as the description
  // under it and read lighter than the `text-sm font-medium` row labels it
  // governs — a caption losing on all three axes to its own content.
  expect(html).toContain('<h4 class="font-heading text-xs-plus font-semibold tracking-tight text-foreground">');
  expect(html).not.toContain("text-foreground/70");
  // And NOT size. It stays a step under the rows: growing it is the only one of
  // the three that moves the caption's box, and so every card below it.
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
