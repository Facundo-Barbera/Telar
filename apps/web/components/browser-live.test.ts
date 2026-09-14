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

  /**
   * THE ACCEPTANCE IS THE FLOOR, NOT THE LABELS. #319 asked that the input never
   * be squeezed below something you can type a URL into; dropping the labels was
   * the means. Since #366 the profile is a glyph rather than its `max-w-28`
   * name, which hands the row back 116px — so the default panel now seats the
   * input AND the viewport's words, and the assertion that matters is the one
   * the issue actually made.
   */
  test("at the panel's default 510px the input clears the floor — the issue's acceptance", () => {
    expect(addressInputRoom(row(510), false)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
    expect(addressInputRoom(row(510), true)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
    expect(addressRowCompact(row(510))).toBe(false);
  });

  test("a panel narrow enough still drops the labels rather than the input", () => {
    // Somewhere below the default the labelled row stops fitting, and the row
    // gives up words before it gives up the address bar. That trade is the
    // whole mechanism, so it is pinned at a width where it still happens.
    expect(addressRowCompact(row(420))).toBe(true);
    expect(addressInputRoom(row(420), false)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
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

  test("the viewport control is the one label that gives way", () => {
    expect(source).toContain('{!compactRow && <span>{viewportMode === "fit" ? "Fit panel"');
  });

  test("the profile control writes no name at any width — it is a glyph, so the budget is honest", () => {
    // The budget above no longer buys a profile label back, which is only true
    // while the markup does not draw one. A label reintroduced here would make
    // ADDRESS_CONTROLS_LABELLED understate the row by 116px and quietly bring
    // back the crushed input of #319.
    expect(source).not.toContain("{state.profile.label}</span>");
    expect(source).toContain('<IdentityIcon icon={state.profile.icon} color={state.profile.color} className="size-3.5 shrink-0" />');
  });

  /**
   * THE LOCK IS THE ROW'S NEWEST CONTROL AND ITS TIGHTEST (#422).
   *
   * The site-permissions anchor is the only thing this row has gained since
   * #319, and the budget above only survives it because it wears `p-0.5` rather
   * than the `p-1` of every button beside it: at the 420px panel the issue was
   * filed about, the compact row clears the input floor by EXACTLY nothing, and
   * `p-1` would put it 4px short. A padding change here is a crushed address bar
   * at that width, which is the bug, returning.
   */
  test("the site-permissions lock is the row's tightest button, which is what the budget assumes", () => {
    expect(source).toContain('"relative shrink-0 rounded-md p-0.5 hover:bg-muted"');
    expect(source).toContain("const ADDRESS_CONTROLS_COMPACT = 4 * 22 + 18 + 26 + 44 + 7 * 4;");
    expect(addressInputRoom(420 - ADDRESS_ROW_PADDING, false)).toBe(ADDRESS_INPUT_FLOOR);
  });

  test("the 1Password warning is a mark with the sentence in its tooltip, not a paragraph in the toolbar", () => {
    expect(source).toContain('<TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />');
    // The sentence is still SAID — in the title and the accessible name, in
    // every phase. A warning nobody can read is not a smaller warning.
    expect(source).toContain('title={`${extension.name ?? "Password manager"}: ${describeExtensionHealth(extension).text}`}');
    expect(source).not.toContain('<span className="max-w-48 truncate">{describeExtensionHealth(extension).text}</span>');
  });
});
