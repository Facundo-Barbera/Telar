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
import { claimNativeView, createOverlayFreezer, nativeViewOverlayHidden, onNativeViewOverlay, type FrozenFrame } from "./native-view-overlay";

const here = fileURLToPath(new URL(".", import.meta.url));
/** The files the panel's menus live in — the ones the native view sits under. */
const SCANNED = ["components/right-panel.tsx", "components/browser-live.tsx"];

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

/**
 * THE FROZEN FRAME'S LIFECYCLE (#475).
 *
 * Hiding the view is what makes a menu visible at all; it is also what made
 * the page blink out on every ⋯. The swap replaces the blink with a picture,
 * and everything worth pinning about it is ORDER — a frame painted before the
 * shell has one is nothing, a frame painted after the menu closed covers a
 * live page, and a hide that lands after the show it was meant to precede
 * leaves the panel blank with no menu on it, which is worse than the blink.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The surface that owns the view, recording the swap in order. `hold` keeps
 *  a capture open the way a slow page does. */
function fakeShell() {
  let release: (() => void) | undefined;
  const shell = {
    log: [] as string[],
    painted: [] as (FrozenFrame | null)[],
    frame: { data: "cG5n", mimeType: "image/png", rect: { x: 1, y: 2, width: 3, height: 4 } } as FrozenFrame | null,
    error: null as Error | null,
    hold: false,
    release: () => release?.(),
    // One call, because the shell captures and THEN hides — a view already
    // down has no frame to give.
    freeze: async () => {
      shell.log.push("capture");
      if (shell.hold) await new Promise<void>((resolve) => { release = resolve; });
      if (shell.error) throw shell.error;
      shell.log.push("hidden");
      return shell.frame;
    },
    show: async () => { shell.log.push("shown"); },
    paint: (frame: FrozenFrame | null) => {
      shell.log.push(frame ? "painted" : "cleared");
      shell.painted.push(frame);
    },
  };
  return shell;
}

describe("the page stays put behind a menu", () => {
  test("the frame is painted only once the shell has captured and hidden", async () => {
    const shell = fakeShell();
    const swap = createOverlayFreezer(shell);
    shell.hold = true;

    const hiding = swap(true);
    await tick();
    // Mid-capture: nothing is painted, because there is nothing to paint yet.
    expect(shell.log).toEqual(["capture"]);

    shell.release();
    await hiding;
    expect(shell.log).toEqual(["capture", "hidden", "painted"]);
    expect(shell.painted.at(-1)).toEqual(shell.frame);
  });

  test("the view comes back BEFORE the frame is dropped — clearing first is the blink again", async () => {
    const shell = fakeShell();
    const swap = createOverlayFreezer(shell);
    await swap(true);
    await swap(false);
    expect(shell.log).toEqual(["capture", "hidden", "painted", "shown", "cleared"]);
  });

  test("a menu that closes mid-capture never paints its frame over the live page", async () => {
    const shell = fakeShell();
    const swap = createOverlayFreezer(shell);
    shell.hold = true;

    const hiding = swap(true);
    await tick();
    const showing = swap(false);
    shell.release();
    await Promise.all([hiding, showing]);

    // The late frame is dropped, and the show ran AFTER the hide rather than
    // racing it — the queue is what keeps the view from being left down.
    expect(shell.log).toEqual(["capture", "hidden", "shown", "cleared"]);
    expect(shell.painted).toEqual([null]);
  });

  test("a menu opened and closed inside one tick never takes the view down at all", async () => {
    const shell = fakeShell();
    const swap = createOverlayFreezer(shell);
    await Promise.all([swap(true), swap(false)]);
    expect(shell.log).toEqual(["shown", "cleared"]);
  });

  test("nothing to capture, and a shell that throws, both leave the host empty rather than stale", async () => {
    const shell = fakeShell();
    const swap = createOverlayFreezer(shell);
    // An older shell, a blank tab, a capture past its budget: the view is
    // down either way and there is simply no picture of it.
    shell.frame = null;
    await swap(true);
    expect(shell.painted).toEqual([null]);

    await swap(false);
    shell.error = new Error("no frame");
    await swap(true);
    expect(shell.painted).toEqual([null, null, null]);

    // And one failed swap does not break the queue every later one rides.
    shell.error = null;
    await swap(false);
    expect(shell.log.at(-1)).toBe("cleared");
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
