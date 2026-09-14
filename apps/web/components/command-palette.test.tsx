/**
 * THE PALETTE'S DIALOG — its keyboard, its rows' anatomy, and the promise that
 * every verb in the rail's header is a command this app actually has (#402).
 *
 * PINNED AGAINST SOURCE, like the project palette's own suite and for the same
 * two reasons: the keyboard cannot be driven by a static render, and the dialog
 * renders through a portal, so there is no markup to assert on either. What CAN
 * be exercised directly — the fold, the ordering, the recency cut, the back
 * rule — is exercised directly, in `lib/command-palette.test.ts`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMMANDS, type CommandId } from "@/lib/commands";

const source = readFileSync(new URL("./command-palette.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./app-sidebar.tsx", import.meta.url), "utf8");

test("EVERY VERB THE RAIL PRESSES IS A COMMAND THIS APP HAS", () => {
  /**
   * THE ONE THAT WOULD HAVE CAUGHT THE REAL BUG. The rail's buttons and the
   * palette's rows now go through the dispatcher by ID, and a typo in one of
   * those strings is a button that silently does nothing — no type error,
   * because `run` takes a `CommandId` and a literal that is not one fails to
   * compile only if it is written inline. It is, today; this is the guard for
   * the day somebody builds the id instead.
   */
  const ids = new Set(COMMANDS.map((command) => command.id as string));
  const pressed = [...sidebar.matchAll(/run\("([a-z-]+)"\)/g)].map((match) => match[1]!);
  expect(pressed.length).toBeGreaterThan(0);
  for (const id of pressed) expect(ids.has(id)).toBe(true);
  // The two verbs in the header's pill, by name. Reveal in Finder was a third
  // until #470: it pressed a command the rail itself bound to a GUESS at the
  // project at hand, and the verb now lives only where a folder can be named —
  // a project group's menu, a session's own Reveal button.
  for (const verb of ["add-project", "new-conversation"] as CommandId[]) {
    expect(pressed).toContain(verb);
  }
  expect(pressed).not.toContain("reveal-in-finder");
});

test("the rail's own bindings name commands that exist too", () => {
  const bound = [...sidebar.matchAll(/"([a-z-]+)": \(\) =>/g)].map((match) => match[1]!);
  const ids = new Set(COMMANDS.map((command) => command.id as string));
  for (const id of bound) expect(ids.has(id)).toBe(true);
  expect(bound).toContain("new-conversation-in");
  expect(bound).toContain("add-project");
});

test("⌘K opens the palette and closes it again, carrying the rail's field in", () => {
  // The field keeps filtering the rows in front of you; the palette is the
  // bigger question, and a search half-typed into one should not have to be
  // retyped into the other.
  expect(sidebar).toContain('"search-sessions": () =>');
  expect(sidebar).toContain('setPalette((current) => (current.open ? { ...current, open: false } : { open: true, page: "root", query }))');
  // And the field is still just a filter — no palette in its keydown.
  const field = sidebar.slice(sidebar.indexOf("const handleSearchKeyDown"), sidebar.indexOf("return (", sidebar.indexOf("const handleSearchKeyDown")));
  expect(field).not.toContain("openPalette");
  expect(field).not.toContain("setPalette");
});

test("the registry is the source of the Actions list, not a second list beside it", () => {
  expect(source).toContain("paletteActions(\n    COMMANDS,");
  // A command is listed only when something can run it: a mounted component has
  // claimed it, or it is pure navigation with a destination.
  expect(source).toContain('Boolean(commandHandler(id)) || commandDestination(id, []).kind !== "noop"');
  expect(source).toContain('["search-sessions"],');
});

test("the chord sits at the row's right, from the live keymap", () => {
  // `KeyHint` (#401) reads the same store `paletteActions` took the chord from,
  // so the row and the key it promises cannot disagree — and `always`, because
  // a palette that showed its chords only while ⌘ was held would teach nobody.
  expect(source).toContain("trailing={<KeyHint command={row.id} always />}");
});

test("the arrows wrap over every row of every section, and Enter takes the highlighted one", () => {
  // Measured from the HIGHLIGHTED row rather than from the counter: the two
  // differ whenever the list shrank under a counter nobody touched since, and
  // moving from the invisible one makes an arrow key appear to skip a row.
  expect(source).toContain("setIndex(((at < 0 ? 0 : at) + delta + rows.length) % rows.length);");
  expect(source).toContain("take(rows[at]);");
  // One counter over the whole palette, not one per section — which is what the
  // per-section offset is for.
  expect(source).toContain("const offsets = sections.map(");
  expect(source).toContain("const position = (offsets[sectionAt] ?? 0) + rowAt;");
});

test("NO ⌘1..⌘9 HERE, unlike the project palette", () => {
  // Those digits are the rail's jump commands and the window dispatcher answers
  // them wherever focus is; a palette that quietly meant something else by them
  // would navigate out from under the reader.
  expect(source).not.toContain("metaKey");
  expect(source).not.toContain("key9");
});

test("an IME's Enter commits a candidate rather than taking a row", () => {
  expect(source).toContain("event.nativeEvent.isComposing || event.keyCode === 229");
});

test("the highlight is announced, not just drawn", () => {
  expect(source).toContain('role="listbox"');
  expect(source).toContain("aria-activedescendant");
  // Each section is a named group, so a screen reader hears which list a row
  // came out of — the caption above it is `aria-hidden`.
  expect(source).toContain('role="group" aria-label={section.title}');
});

test("focus is the browser's — never a focus() call, which kills the WebKit build", () => {
  expect(source).toContain("autoFocus");
  expect(/\b(current|ref|input|element)\??\.focus\(\)/.test(source)).toBe(false);
});

test("the sub-pages are the project palette's own, embedded rather than rebuilt", () => {
  // #395/#413 built the Projects page, the Sources page, the folder browser and
  // the clone flow. A second copy of any of that is a second copy to keep right.
  expect(source).toContain("<ProjectPalettePages");
  expect(source).toContain("page={page}");
  // Backspace on an empty field walks back out of them to this palette's list.
  expect(source).toContain("onBack={() => {");
  expect(source).toContain('setPage("root");');
});

test("a row that walks does not also close the dialog", () => {
  const take = source.slice(source.indexOf("const take ="), source.indexOf("const onKeyDown ="));
  expect(take).toContain("if (row.page) {");
  expect(take).toContain("setPage(SUB_PAGE[row.page]);");
  // Everything else closes first and then acts, so a navigation never happens
  // behind a dialog that is still up.
  expect(take).toContain("onOpenChange(false);\n    onRun(row.id);");
});

test("a fresh palette every time, seeded with what the rail's field held", () => {
  const fresh = source.slice(source.indexOf("if (open !== wasOpen) {"));
  expect(fresh.slice(0, 240)).toContain("setPage(openOn);");
  expect(fresh.slice(0, 240)).toContain("setQuery(seed);");
  expect(fresh.slice(0, 240)).toContain("setIndex(0);");
});

test("a page asked for while the palette is already up is still a page asked for", () => {
  // The New-conversation row closes the palette and runs the command, and that
  // command re-opens it on Projects — one render, so `open` never flips. Without
  // this the row would visibly do nothing.
  expect(source).toContain("} else if (open && openOn !== wasPage) {");
  const reopen = source.slice(source.indexOf("} else if (open && openOn !== wasPage) {"));
  expect(reopen.slice(0, 160)).toContain("setPage(openOn);");
});

test("the legend names the keys, because a palette whose keys are invisible is a list people click", () => {
  expect(source).toContain("↑↓</kbd> Navigate");
  expect(source).toContain("Enter</kbd> Select");
  expect(source).toContain("Esc</kbd> Close");
});

test("it searches what the rail already has, and reads nothing of its own", () => {
  // No engine client in this file: the projects and the conversations are the
  // rail's, so the palette can never offer a row the rail does not have.
  expect(source).not.toContain("createEngineApi");
  expect(sidebar).toContain("sessions={sessions}");
  expect(sidebar).toContain("targets={pickerTargets}");
});
