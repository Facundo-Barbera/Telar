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
  // `asked` rides along with `open` on every path that can open the palette —
  // it is the latch that keeps 68 kB of dialog out of the rail's own bundle
  // until somebody asks for it (#492), so a path that opened without setting it
  // would render a palette that never loads.
  expect(sidebar).toContain('setPalette((current) => (current.open ? { ...current, open: false } : { open: true, asked: true, page: "root", query }))');
  // And the field is still just a filter — no palette in its keydown.
  const field = sidebar.slice(sidebar.indexOf("const handleSearchKeyDown"), sidebar.indexOf("return (", sidebar.indexOf("const handleSearchKeyDown")));
  expect(field).not.toContain("openPalette");
  expect(field).not.toContain("setPalette");
});

/**
 * THE LATCH IS AN INVARIANT, NOT A LINE (#492).
 *
 * The palette is `next/dynamic` now and the rail renders it only once
 * `palette.asked` is true, so a new way to open it that sets `open` alone is a
 * ⌘K that does nothing at all — no type error, because both fields are on the
 * same object and `open: true` is a complete expression by itself. The failure
 * would be invisible in review and total at runtime, which is exactly the shape
 * worth spending a test on.
 */
test("every path that opens the palette also latches it into existence", () => {
  const opens = [...sidebar.matchAll(/open: true[^}]*/g)].map((match) => match[0]);
  expect(opens.length).toBeGreaterThan(0);
  for (const open of opens) expect(open).toContain("asked: true");
  // ...and the one path that can only be told `open` from outside carries the
  // latch forward rather than dropping it on close.
  expect(sidebar).toContain("asked: current.asked || open");
});

test("the registry is the source of the Actions list, not a second list beside it", () => {
  expect(source).toContain("paletteActions(\n    COMMANDS,");
  // A command is listed only when something can run it: a mounted component has
  // claimed it, or it is pure navigation with a destination.
  expect(source).toContain('Boolean(commandHandler(id)) || commandDestination(id, []).kind !== "noop"');
  // The palette that opened this dialog is never a row in it, and neither is a
  // command whose row moved down into Quick settings (#479).
  expect(source).toContain('["search-sessions", ...PALETTE_QUICK_COMMANDS],');
});

test("a glyph per command, resolved through the one map (#479)", () => {
  // The palette used to draw one glyph per GROUP, which made the list scannable
  // by section and not by row — the wrong unit for a surface whose whole job is
  // finding one verb among twenty-odd.
  expect(source).toContain("const Glyph = commandIcon(row.id);");
  expect(source).toContain('import { commandIcon, iconByName } from "@/lib/command-icons";');
  // And the group map is gone from this file: the fallback lives with the map.
  expect(source).not.toContain("GROUP_ICONS");
});

test("every settings write goes through the one adapter, so #471 rebases one file", () => {
  // The palette must not reach into the theme store, the appearance store or
  // the Looks shelf itself — lib/quick-settings.ts is the only door, and that
  // is what keeps the Appearance rework a single-file rebase.
  expect(source).toContain('import { ACCENTS, ACCENT_LABELS, useQuickSettings } from "@/lib/quick-settings";');
  for (const store of ["@/lib/appearance", "@/lib/looks", "@/lib/theme-palettes", "@/components/theme-provider"]) {
    expect(source).not.toContain(store);
  }
});

test("a quick row applies and LEAVES THE PALETTE OPEN", () => {
  // The one place these rows behave unlike every other: they are knobs, not
  // verbs. Stepping the text size twice is ordinary, and a dialog that shut
  // after each step would make the second press a whole ⌘K again.
  const take = source.slice(source.indexOf("const take ="), source.indexOf("const onKeyDown ="));
  const quick = take.slice(take.indexOf('if (row.kind === "quick")'), take.indexOf("// A door walks"));
  expect(quick).toContain("setNotice(quick.apply(row.id));");
  expect(quick).not.toContain("onOpenChange(false)");
  // Its readout sits where a command's chord would — a verb promises a key, a
  // knob reports a state.
  expect(source).toContain('<span className="shrink-0 text-2xs text-muted-foreground">{row.value}</span>');
});

test("the Looks and Accent pages are pages of THIS dialog, not a second one", () => {
  // #479 asked for the palette's existing sub-page mechanism rather than a new
  // dialog — so these are `page` values on the same DialogContent.
  expect(source).toContain('page === "looks" ?');
  expect(source).toContain('page === "accent" ?');
  expect(source).not.toContain("<Dialog open={true}");
  // One page component serves both lists: same chrome, different data.
  expect(source).toContain("function QuickPage({");
  // Backspace on an EMPTY field is the way back, as everywhere else here.
  expect(source).toContain('if (event.key === "Backspace" && query === "") {');
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
  // `walk` is that one move — the page, a cleared query, the highlight home —
  // named once now that four pages use it rather than spelled out at each.
  expect(source).toContain('onBack={() => walk("root")}');
  expect(source).toContain("const walk = (to: CommandPalettePage) => {");
  expect(source).toContain('setPage(to);');
});

test("a row that walks does not also close the dialog", () => {
  const take = source.slice(source.indexOf("const take ="), source.indexOf("const onKeyDown ="));
  expect(take).toContain("if (row.page) {");
  expect(take).toContain("walk(SUB_PAGE[row.page]);");
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
