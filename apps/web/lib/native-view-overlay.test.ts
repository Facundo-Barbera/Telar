/**
 * THE RULE THIS FILE PINS: every menu in the right panel takes the native
 * browser view down while it is open.
 *
 * It is two tests, because the rule has two halves. The first is the counter
 * itself — one menu closing as another opens must not reveal the page under
 * the second. The second is a SOURCE SCAN, in the same spirit as
 * `components/ui/dropdown-menu.test.ts`: the failure it guards is not a type
 * error or a crash, it is a menu somebody adds to the panel next month that
 * renders *behind* the page on the desktop build and nowhere else. Nothing
 * else would catch that until a user reported a menu they could not see.
 *
 * The scan is deliberately a HEURISTIC — it does not parse JSX. It requires
 * each menu root in those two files to be CONTROLLED (`open={…}`) and to share
 * an identifier with something the file hands `useNativeViewOverlay`.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimNativeView, nativeViewOverlayHidden, onNativeViewOverlay } from "./native-view-overlay";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The files the panel's menus live in — the ones the native view sits under. */
const SCANNED = ["components/right-panel.tsx"];

describe("the native view is claimed while a menu is open", () => {
  test("the last release is what shows the page again", () => {
    expect(nativeViewOverlayHidden()).toBe(false);
    const first = claimNativeView();
    expect(nativeViewOverlayHidden()).toBe(true);
    // A second menu opening over the first, then the FIRST closing: the view
    // must stay down, or the page would draw over what is still open.
    const second = claimNativeView();
    first();
    expect(nativeViewOverlayHidden()).toBe(true);
    // A release is per claim and idempotent — a double call frees nobody else.
    first();
    expect(nativeViewOverlayHidden()).toBe(true);
    second();
    expect(nativeViewOverlayHidden()).toBe(false);
  });

  test("the live browser is told on subscribe and on every change", () => {
    const seen: boolean[] = [];
    const unsubscribe = onNativeViewOverlay((hidden) => seen.push(hidden));
    // Called once with the current state, so a surface mounting under an open
    // menu does not reveal the page behind it.
    expect(seen).toEqual([false]);
    const release = claimNativeView();
    release();
    expect(seen).toEqual([false, true, false]);
    unsubscribe();
    claimNativeView()();
    expect(seen).toEqual([false, true, false]);
  });
});

/** The opening tag that starts at `start`, whose `>` may sit inside a JSX
 *  expression (`onOpenChange={(open) => …}`), so braces are counted. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** The text inside the braces or parens beginning at `open`. */
function balanced(source: string, open: number, pair: "{}" | "()"): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === pair[0]) depth += 1;
    else if (source[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

function identifiers(expression: string): string[] {
  return expression.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Menu roots (`<Popover`, `<DropdownMenu` — not their parts) with the
 *  expression driving each one's `open` prop, or null when uncontrolled. */
function menuRoots(source: string): { name: string; open: string | null; line: number }[] {
  const found: { name: string; open: string | null; line: number }[] = [];
  for (const match of source.matchAll(/<(Popover|DropdownMenu|ContextMenu)(?![A-Za-z])/g)) {
    const tag = openingTag(source, match.index);
    const at = tag.search(/(?:^|\s)open=\{/);
    found.push({
      name: match[1],
      open: at === -1 ? null : balanced(tag, tag.indexOf("{", at), "{}"),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

/** Every identifier this file hands to the overlay hook. */
function guardedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/useNativeViewOverlay\(/g)) {
    const open = source.indexOf("(", match.index);
    for (const name of identifiers(balanced(source, open, "()"))) names.add(name);
  }
  return names;
}

/** The menus in `source` that no `useNativeViewOverlay` call covers. */
function unguardedMenus(source: string): string[] {
  const guarded = guardedNames(source);
  return menuRoots(source)
    .filter((menu) => menu.open === null || !identifiers(menu.open).some((name) => guarded.has(name)))
    .map((menu) => `${menu.name}:${menu.line}`);
}

describe("every menu over the native view is wrapped by the hook", () => {
  test("the scan catches an unguarded menu, and an uncontrolled one", () => {
    const guarded = `useNativeViewOverlay(openOverlay !== null);\n<Popover open={openOverlay === "profile"} onOpenChange={(open) => (open ? x() : y())}>`;
    expect(unguardedMenus(guarded)).toEqual([]);
    // Controlled, but by state the hook never sees.
    expect(unguardedMenus(`useNativeViewOverlay(chooserOpen);\n<DropdownMenu open={otherOpen}>`)).toEqual(["DropdownMenu:2"]);
    // Uncontrolled: nothing to hand over, so nothing hides the view.
    expect(unguardedMenus(`useNativeViewOverlay(chooserOpen);\n<DropdownMenu>`)).toEqual(["DropdownMenu:2"]);
    // A part of a menu is not a root — these must not be mistaken for one.
    expect(unguardedMenus(`<PopoverTrigger /><DropdownMenuItem />`)).toEqual([]);
  });

  test("the panel's own files ship no menu the hook does not cover", () => {
    for (const file of SCANNED) {
      const source = fs.readFileSync(path.join(here, "..", file), "utf8");
      // A file with menus must call the hook at all — a scan that silently
      // passes because it found nothing is the failure mode to avoid.
      expect(menuRoots(source).length).toBeGreaterThan(0);
      expect([file, ...unguardedMenus(source)]).toEqual([file]);
    }
  });
});
