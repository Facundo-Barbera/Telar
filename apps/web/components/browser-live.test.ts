// @ts-expect-error Bun test types are provided by the test runner.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDRESS_CONTROLS,
  ADDRESS_INPUT_FLOOR,
  ADDRESS_ROW_PADDING,
  ADDRESS_TOOLS,
  addressInputRoom,
  addressRowFitsTools,
  zoomLabel,
} from "./browser-live";
// The bridge probe moved out of the surface so the surface could be split off
// the conversation route's first bundle (#492); the rule it enforces is
// unchanged and so is the test below.
import { desktopBrowserBridge } from "../lib/desktop-browser-bridge";

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
 * #319'S MECHANISM WAS "DROP LABELS BEFORE WIDTH", AND IT IS GONE because both
 * labels are: the profile became a glyph (#366) and the viewport left the row
 * entirely for the device toolbar (#473). What survives is the acceptance —
 * the input clears a floor you can type a URL into — so that is what is pinned
 * here. A control that wants words back wants the measuring hook back with it.
 *
 * The arithmetic is tested rather than the pixels because the arithmetic IS
 * the rule; the scan below is what keeps the markup and the budget one claim.
 */
describe("the address row's width budget", () => {
  /** Panel width → the content width the row's controls are spent from. */
  const row = (panel: number) => panel - ADDRESS_ROW_PADDING;

  test("at the panel's default 510px the input clears the floor — the issue's acceptance", () => {
    expect(addressInputRoom(row(510))).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("and at the 420px panel #319 was actually filed about", () => {
    expect(addressInputRoom(row(420))).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("the budget is the row's eight children and the seven gaps between them", () => {
    // back, forward, reload and the profile mark at 22; the lock at 18; the
    // password control at its 44 widest; the ⋯ at 22; seven 4px gaps.
    expect(ADDRESS_CONTROLS).toBe(4 * 22 + 18 + 44 + 22 + 7 * 4);
  });

  test("a wider panel is only ever roomier — nothing on this row grows with width", () => {
    for (let width = 200; width < 900; width += 1) {
      expect(addressInputRoom(width + 1)).toBe(addressInputRoom(width) + 1);
    }
  });
});

/**
 * THE CAMERA AND THE PEN FOLD RATHER THAN CRUSH THE INPUT (#474).
 *
 * The budget above has FOUR PIXELS of slack at the 420px panel #319 was filed
 * about, so two more glyphs on the row unconditionally would put the address
 * bar back under its floor — which is exactly the bug #319 exists to stop, and
 * a shortcut is not worth it. So the row spends `ADDRESS_TOOLS` only when the
 * input still clears the floor afterwards, and below that width both gestures
 * live in the `⋯` menu, where they are listed at every width anyway.
 */
describe("the two folding tool glyphs", () => {
  const row = (panel: number) => panel - ADDRESS_ROW_PADDING;

  test("they cost two glyphs and the two gaps before them", () => {
    expect(ADDRESS_TOOLS).toBe(2 * 22 + 2 * 4);
  });

  test("at the panel's default 510px the row carries them and the input still clears the floor", () => {
    expect(addressRowFitsTools(row(510))).toBe(true);
    expect(addressInputRoom(row(510), true)).toBeGreaterThanOrEqual(ADDRESS_INPUT_FLOOR);
  });

  test("at the 420px panel #319 was filed about they fold — the input wins", () => {
    expect(addressRowFitsTools(row(420))).toBe(false);
    // Unfolded they would breach the floor, which is the whole reason to fold.
    expect(addressInputRoom(row(420), true)).toBeLessThan(ADDRESS_INPUT_FLOOR);
    // Folded, the row is exactly what #473 left it as.
    expect(addressInputRoom(row(420))).toBe(addressInputRoom(row(420), false));
  });

  test("the fold is monotone: a row that fits them keeps fitting them as it widens", () => {
    let seen = false;
    for (let width = 200; width < 900; width += 1) {
      const fits = addressRowFitsTools(width);
      if (fits) seen = true;
      // Never back to false once true.
      expect(!seen || fits).toBe(true);
    }
    expect(seen).toBe(true);
  });
});

describe("the row's markup is the budget's own claim", () => {
  const source = fs.readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "browser-live.tsx"), "utf8");

  test("the input takes the slack and can be crushed by nothing", () => {
    expect(source).toContain('className="h-6 min-w-0 flex-1 rounded-md border border-transparent bg-muted/60 px-2 font-mono text-2xs outline-none focus:border-ring"');
  });

  test("the row spells NOTHING out — which is why the budget is one number", () => {
    // The measuring hook and its labelled/compact split are gone with the two
    // labels; reintroducing a label without them is #319 returning with
    // nothing left to protect the input.
    expect(source).not.toContain("compactRow");
    expect(source).not.toContain("useCompactAddressRow");
    // The viewport's words, which were the last thing the row wrote out.
    expect(source).not.toContain('{viewportMode === "fit" ? "Fit panel"');
  });

  test("the profile control writes no name at any width — it is a glyph, so the budget is honest", () => {
    // A label on the ROW would make ADDRESS_CONTROLS understate it by 116px
    // and quietly bring back the crushed input of #319. The name is still
    // said where there is room for it: the menu, the title, the aria-label.
    expect(source).not.toContain('<span className="max-w-28 truncate">{state.profile.label}</span>');
    expect(source).toContain('<IdentityIcon icon={state.profile.icon} color={state.profile.color} className="size-3.5 shrink-0" />');
  });

  /**
   * THE LOCK IS THE ROW'S TIGHTEST BUTTON (#422), AND THAT IS THE SLACK.
   *
   * The site-permissions anchor wears `p-0.5` rather than the `p-1` of every
   * button beside it. At the 420px panel #319 was filed about, the row clears
   * the floor by exactly what that choice saves — so a padding change here is
   * a crushed address bar at that width, which is the bug, returning.
   */
  test("the site-permissions lock is the row's tightest button, which is what the budget assumes", () => {
    expect(source).toContain('"relative shrink-0 rounded-md p-0.5 hover:bg-muted"');
    expect(source).toContain("export const ADDRESS_CONTROLS = 4 * 22 + 18 + 44 + 22 + 7 * 4;");
    // `p-1` would cost the lock 4 more px, which is the whole of the slack.
    expect(addressInputRoom(420 - ADDRESS_ROW_PADDING) - 4).toBe(ADDRESS_INPUT_FLOOR);
  });

  /**
   * The glyphs are gated on the MEASURED row, not on a guess — and the same
   * two gestures are in the `⋯` menu unconditionally, so folding costs a
   * shortcut and never a capability.
   */
  test("the camera and the pen are drawn only when the measured row can afford them", () => {
    expect(source).toContain("{rowFitsTools && canCapture ? (");
    expect(source).toContain("const rowFitsTools = useAddressRowTools(addressRowRef);");
    // ...and the menu's rows are gated on `canCapture` alone, at every width.
    expect(source).toContain("{canCapture ? (");
    expect(source).toContain("Screenshot the full page");
    expect(source).toContain("Annotate this page");
  });

  test("the 1Password warning is a mark with the sentence in its tooltip, not a paragraph in the toolbar", () => {
    expect(source).toContain('<TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />');
    // The sentence is still SAID — in the title and the accessible name, in
    // every phase. A warning nobody can read is not a smaller warning.
    expect(source).toContain('title={`${extension.name ?? "Password manager"}: ${describeExtensionHealth(extension).text}`}');
    expect(source).not.toContain('<span className="max-w-48 truncate">{describeExtensionHealth(extension).text}</span>');
  });
});

/** The zoom readout, which is also the reset button's label. */
describe("the options menu's zoom readout", () => {
  test("it is a whole percentage, and a tab with no factor yet reads 100%", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(0.67)).toBe("67%");
    // Never "NaN%" for a state that has not arrived, and never "0%".
    expect(zoomLabel(undefined)).toBe("100%");
    expect(zoomLabel(0)).toBe("100%");
    expect(zoomLabel(Number.NaN)).toBe("100%");
  });
});
