// @ts-expect-error Bun test types are provided by the test runner.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDRESS_INPUT_FLOOR,
  ADDRESS_ROW_PADDING,
  addressInputRoom,
  addressRowCompact,
  desktopBrowserBridge,
} from "./browser-live";

test("remote host routes cannot use this computer's native browser", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = {};
  const location = { pathname: "/projects/project_local/sessions/session_local" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location, telarDesktop: { browser: bridge } } });
  try {
    expect(desktopBrowserBridge()).toBe(bridge);
    location.pathname = "/hosts/remote-mac/projects/project_remote/sessions/session_remote";
    expect(desktopBrowserBridge()).toBeUndefined();
    location.pathname = "/projects/project_local/sessions/session_local";
    expect(desktopBrowserBridge()).toBe(bridge);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

/**
 * THE ADDRESS BAR SURVIVES THE DEFAULT PANEL WIDTH (#319).
 *
 * It did not: at the right panel's ~510px the labelled viewport control, the
 * profile label and the 1Password health sentence took the row, and the one
 * control on it you TYPE into was squeezed to about 30px — "Typ" — with no way
 * to reach the address bar from the keyboard at that width.
 *
 * The arithmetic is tested rather than the pixels because this app has no DOM
 * harness (see `composer.test.ts`), and the arithmetic IS the rule: the row
 * measures itself and the budget below decides what it can afford to write out.
 * The scan at the bottom is what keeps the markup and the budget the same claim.
 */
describe("the address row's width budget", () => {
  /** Panel width → the content width the row's ResizeObserver reports. */
  const row = (panel: number) => panel - ADDRESS_ROW_PADDING;

  test("at the panel's default 510px the labels come off", () => {
    expect(addressRowCompact(row(510))).toBe(true);
  });

  test("and what that leaves the input clears the floor — the issue's acceptance", () => {
    expect(addressInputRoom(row(510), false)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
    // The bug itself, stated: labelled, this row cannot seat the input.
    expect(addressInputRoom(row(510), true)).toBeLessThan(ADDRESS_INPUT_FLOOR);
  });

  test("a panel with room keeps its labels, and the input still clears the floor", () => {
    expect(addressRowCompact(row(720))).toBe(false);
    expect(addressInputRoom(row(720), true)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("the switch happens exactly where the labelled row stops clearing the floor", () => {
    // No gap and no overlap between the two states: one px either side of the
    // threshold is the only place the answer changes.
    for (let width = 200; width < 900; width += 1) {
      expect(addressRowCompact(width)).toBe(addressInputRoom(width, true) < ADDRESS_INPUT_FLOOR);
    }
  });

  test("no width is compact AND short of the floor — the fallback is always the roomier one", () => {
    for (let width = 420; width < 900; width += 1) {
      if (!addressRowCompact(width)) continue;
      expect(addressInputRoom(width, false)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
    }
  });
});

describe("the row's markup is the budget's own claim", () => {
  const source = fs.readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "browser-live.tsx"), "utf8");

  test("the input takes the slack and can be crushed by nothing", () => {
    expect(source).toContain('className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-[0.6875rem] outline-none focus:border-ring"');
  });

  test("the row measures ITSELF — a window-width query cannot see this column", () => {
    expect(source).toContain("const compactRow = useCompactAddressRow(addressRowRef);");
    expect(source).toContain("ref={addressRowRef}");
    expect(source).toContain("setCompact(addressRowCompact(entry.contentRect.width))");
  });

  test("both labelled controls are the ones that give way", () => {
    expect(source).toContain('{!compactRow && <span>{viewportMode === "fit" ? "Fit panel"');
    expect(source).toContain('{!compactRow && <span className="max-w-28 truncate">{state.profile.label}</span>}');
  });

  test("the 1Password warning is a mark with the sentence in its tooltip, not a paragraph in the toolbar", () => {
    expect(source).toContain('<TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />');
    // The sentence is still SAID — in the title and the accessible name, in
    // every phase. A warning nobody can read is not a smaller warning.
    expect(source).toContain('title={`${extension.name ?? "Password manager"}: ${describeExtensionHealth(extension).text}`}');
    expect(source).not.toContain('<span className="max-w-48 truncate">{describeExtensionHealth(extension).text}</span>');
  });
});
