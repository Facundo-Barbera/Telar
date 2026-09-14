/**
 * THE BROWSER'S MARKUP AND ITS TWO BROWSER-ONLY DECISIONS.
 *
 * The keyboard is `lib/directory-browser.test.ts` — it is a pure fold, so it is
 * tested as one. What is left here is what only exists once this renders: the
 * labels and aria wiring, the button that says what pressing it does, and the
 * handful of rules that cannot be a function because they read `window` (the
 * remembered directory, the Finder bridge). Those are pinned against source,
 * exactly as project-palette.test.tsx pins its own — a static render runs no
 * effects, so there is no listing in the markup to assert on.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectoryBrowser } from "./directory-browser";

const source = readFileSync(new URL("./directory-browser.tsx", import.meta.url), "utf8");

const never = () => new Promise<never>(() => {});

const render = (props: Partial<Parameters<typeof DirectoryBrowser>[0]> = {}) =>
  renderToStaticMarkup(
    <DirectoryBrowser actionLabel="Add" onSubmit={() => {}} onBack={() => {}} list={never} {...props} />,
  );

test("the first paint is a field, a captioned list and a legend — never a blank panel", () => {
  const html = render();
  expect(html).toContain('aria-label="Folder path"');
  expect(html).toContain("Directories");
  // The listing has not landed yet, and saying so beats an empty list that
  // reads as "this folder has nothing in it".
  expect(html).toContain("Reading that folder…");
  expect(html).toContain("Navigate");
  expect(html).toContain("Up");
});

test("the button says what pressing it DOES, and names the key that does it", () => {
  // "Add" for a folder that holds the project; "Clone here" for the parent the
  // checkout will land in — the folder taken is not the same thing in the two
  // flows, so one label for both would be wrong in one of them.
  expect(render({ actionLabel: "Add" })).toContain("Add");
  expect(render({ actionLabel: "Clone here" })).toContain("Clone here");
  // ⌘Enter is not a key anybody guesses, and it is the one that finishes.
  expect(render()).toContain("⌘↵");
});

test("the highlight is announced, not just drawn", () => {
  const html = render();
  expect(html).toContain('role="combobox"');
  expect(html).toContain('role="listbox"');
  expect(html).toContain('aria-controls="directory-browser-entries"');
  expect(source).toContain('role="option"');
  expect(source).toContain("aria-selected={on}");
  expect(source).toContain("aria-activedescendant");
});

test("the dotfolder toggle offers the OTHER state, and names its chord", () => {
  const html = render();
  // `hidden` is the engine's word for "they are shown", so the button that
  // turns them on has to read "Show" — the inverted pair is an easy slip.
  expect(html).toContain('aria-label="Show dotfolders"');
  expect(html).toContain("Show dotfolders (⌘.)");
  expect(source).toContain('aria-label={hidden ? "Hide dotfolders" : "Show dotfolders"}');
});

test("the caller's sentence is shown, and its own refusal wins over it", () => {
  // A clone that failed is the caller's to explain; a folder that would not
  // list is this component's, and it is the more recent thing that happened.
  expect(render({ notice: "That repository already exists there." })).toContain("That repository already exists there.");
  expect(source).toContain("{error ?? notice}");
});

test("the busy state is the button's, not a spinner over the whole panel", () => {
  const html = render({ busy: true });
  expect(html).toContain("animate-spin");
  expect(html).toContain("disabled");
});

/* ─── what only a browser can decide ─────────────────────────────────────── */

test("the last directory is remembered per host, and a stale one is not a dead browser", () => {
  expect(source).toContain("remembered(hostId)");
  expect(source).toContain("remember(hostId, answer.path)");
  // A remembered folder that has since been deleted falls back to home ONCE,
  // rather than opening every visit on a refusal.
  expect(source).toContain("fellBack.current = true;");
  expect(source).toContain("setTarget(undefined);");
  // localStorage throws outright in some privacy modes, which is not a reason
  // to fail to draw a browser.
  expect(source).toContain("window.localStorage.getItem");
  expect(/catch\s*\{\s*return undefined;/.test(source)).toBe(true);
});

test("Open in Finder is a secondary link, desktop-only, and never for another Mac", () => {
  // Revealing a same-named path on THIS Mac would show somebody the wrong
  // folder — the rule lib/workspace-open.ts already states for a session.
  expect(source).toContain("const here = !hostId || hostId === LOCAL_HOST_ID;");
  expect(source).toContain("Boolean(bridge?.reveal) && here");
  expect(source).toContain("Open in Finder");
  // A link, not a button beside the primary one: it chooses nothing.
  expect(source).toContain("underline underline-offset-2");
  // And it is absent in a browser tab rather than greyed — a promise the web
  // cannot keep, restated on every visit.
  expect(render()).not.toContain("Open in Finder");
});

test("the native picker is offered only when the engine is unreachable", () => {
  // The listing comes over HTTP, so no adapter means no browser at all —
  // while `chooseDirectory` goes through the shell's own IPC and still works.
  expect(source).toContain('code === "engine_unavailable"');
  expect(source).toContain("Choose a folder with the system picker instead");
  expect(render()).not.toContain("Choose a folder with the system picker instead");
});

test("the fetch sets no state synchronously, which this app's lint rule refuses", () => {
  // A `setLoading(true)` in the effect body cascades a second render on every
  // listing; the spinner is turned on by whatever changed the target.
  const effect = source.slice(source.indexOf("useEffect(() => {"), source.indexOf("const entries ="));
  expect(effect).not.toContain("setLoading(true);\n    void list");
  expect(source).toContain("const showHidden = (next: boolean) => {");
});

test("the keys are caught for the whole page, because clicking a row moves focus", () => {
  // ⌘Enter has to keep working from a row's button, so the handler is on a
  // `display: contents` wrapper rather than on the field alone.
  expect(source).toContain('<div className="contents" onKeyDown={onKeyDown}>');
});
