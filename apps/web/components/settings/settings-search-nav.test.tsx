// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { SettingsSearchNav } from "./settings-search-nav";

/**
 * The idle field is rendered; everything the KEYBOARD does is read from source.
 *
 * A static render cannot type, so the parts that only exist after a keystroke —
 * the results list, the empty line, Escape — are pinned against the file. That
 * is weaker than driving it, and it was the right trade for the three rules
 * that would otherwise be checked by nobody: `/` must not steal a slash from a
 * text field, the highlight must be announced, and clearing must put the panes
 * back.
 *
 * IT IS NO LONGER THE ONLY TRADE AVAILABLE. This file predates #732's fix: a
 * controlled field can now be typed into (`lib/testing/type-into.ts`), so these
 * could be mounted and driven instead of matched against source. Doing that is
 * a rewrite of this file rather than an edit, and it is left for whoever next
 * touches this nav — the source pins are honest about what they are, and they
 * are not wrong, only weak.
 */
const source = readFileSync(new URL("./settings-search-nav.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("./settings-shell.tsx", import.meta.url), "utf8");

test("at rest it is a combobox showing the key that focuses it", () => {
  const html = renderToStaticMarkup(
    <SettingsSearchNav index={SETTINGS_SEARCH_INDEX} onChoose={() => undefined}>
      <nav>the panes</nav>
    </SettingsSearchNav>,
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("<kbd");
  expect(html).toContain(">/</kbd>");
  // Nothing is replaced until something is typed.
  expect(html).toContain("the panes");
});

test("the slash key is suppressed where a slash is a slash", () => {
  // The same rule the command keys apply, imported rather than re-decided.
  expect(source).toContain('from "@/lib/command-keys"');
  expect(source).toContain("if (isEditableTarget(event.target)) return;");
});

test("the highlight is announced, not just drawn", () => {
  expect(source).toContain("aria-activedescendant");
  expect(source).toContain('role="listbox"');
  expect(source).toContain('role="option"');
  expect(source).toContain('aria-selected={on}');
});

test("Escape clears before it leaves", () => {
  const escape = source.slice(source.indexOf('event.key === "Escape"'));
  expect(escape.slice(0, 400)).toContain('setQuery("")');
  expect(escape.slice(0, 400)).toContain("blur()");
});

test("the empty state is one line", () => {
  expect(source).toContain("No settings found.");
});

test("choosing a result navigates, centres, focuses and pulses", () => {
  // All four, in one place: the shell owns the pane switch and the scroll, so
  // it is the file that has to do the rest.
  expect(shell).toContain("onSelect(entry.pageId)");
  expect(shell).toContain('block: "center"');
  expect(shell).toContain("focus({ preventScroll: true })");
  expect(shell).toContain('classList.add("settings-search-target-pulse")');
  // And asking for less motion drops both motions rather than the jump.
  expect(shell).toContain('prefers-reduced-motion: reduce');
});
