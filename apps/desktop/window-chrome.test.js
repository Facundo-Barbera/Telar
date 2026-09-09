// The window chrome: which platforms hand their titlebar to the app, and where
// the traffic lights land when they do.
//
// WHAT THIS IS ACTUALLY GUARDING is the platform rule. `hiddenInset` is treated
// as `hidden` off macOS — minimise, maximise and close disappear and the app is
// expected to draw its own, which this cockpit does not. Shipping that would be
// a window you cannot close, from a one-word change nobody would think to
// re-test on a platform they were not running.

const { describe, expect, test } = require("bun:test");
const {
  APP_HEADER_HEIGHT,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_POSITION,
  macWindowChrome,
} = require("./window-chrome.js");

describe("macWindowChrome", () => {
  test("hands the titlebar to the app on macOS", () => {
    expect(macWindowChrome("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    });
  });

  test("leaves every other platform its system titlebar", () => {
    // An app whose close button vanished is a worse outcome than a grey strip.
    for (const platform of ["win32", "linux", "freebsd"]) expect(macWindowChrome(platform)).toEqual({});
  });

  test("hands back a COPY, so a caller cannot mutate the shared position", () => {
    const first = macWindowChrome("darwin");
    first.trafficLightPosition.x = 999;
    expect(macWindowChrome("darwin").trafficLightPosition.x).toBe(TRAFFIC_LIGHT_POSITION.x);
  });
});

describe("the lights sit on the app header's centreline", () => {
  test("y centres the group in the renderer's own header, rather than topping the window", () => {
    // The whole point of `hiddenInset` here: the app's header BECOMES the
    // titlebar. Lights parked at the top of the window instead would just give
    // the app a shorter grey bar with a wordmark below it.
    expect(TRAFFIC_LIGHT_POSITION.y).toBe((APP_HEADER_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2);
  });

  test("the top and left insets are equal (a balanced corner)", () => {
    expect(TRAFFIC_LIGHT_POSITION.x).toBe(TRAFFIC_LIGHT_POSITION.y);
  });

  test("the group fits inside the header with room to spare", () => {
    expect(TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_DIAMETER).toBeLessThan(APP_HEADER_HEIGHT);
    expect(TRAFFIC_LIGHT_POSITION.y).toBeGreaterThan(0);
  });

  test("the renderer reserves at least as much width as the lights occupy", () => {
    // `--titlebar-inset` in apps/web/app/globals.css is the other half of
    // this contract, and the two live in different apps — so the number is read
    // from the stylesheet rather than restated here, where it could drift.
    //
    // READ FROM THE SHELL'S OWN RULE, not from whichever declaration is
    // largest. The property is declared twice — `0px` on `:root` for a browser
    // tab, the real reservation under `[data-telar-shell="macos"]` — and a
    // check that took the maximum would still pass if the macOS rule were
    // broken and some other selector happened to carry a big number.
    const insetPx = Number.parseFloat(cssVarIn('[data-telar-shell="macos"]', "--titlebar-inset"));
    // Three lights plus the two gaps between them, starting at x.
    const occupied = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_DIAMETER * 3 + 8 * 2;
    expect(insetPx).toBeGreaterThanOrEqual(occupied);
  });

  test("a browser tab reserves nothing — the inset is the shell's alone", () => {
    // The other half of reading the macOS rule specifically: `:root` must stay
    // at zero, or every page outside the shell grows a 76px hole at top-left.
    expect(cssVarIn(":root", "--titlebar-inset")).toBe("0px");
  });

  test("the renderer's header is the height the lights were centred in", () => {
    /**
     * THE DRIFT THIS EXISTS TO CATCH ALREADY HAPPENED ONCE. The lights were
     * centred in 56px — the rail's header — while the session masthead was 44px,
     * so hiding the rail put them 6px below the breadcrumb sitting beside them.
     * Reported as "the height of the items doesn't match the semaphore", which
     * is exactly what a 6px offset looks like.
     *
     * One number, two processes, and neither can move without this failing.
     */
    expect(Number(cssVar(/--titlebar-height:\s*([\d.]+)px/))).toBe(APP_HEADER_HEIGHT);
  });

  test("the window geometry is declared in px, never rem", () => {
    /**
     * THE FONT-SIZE PREFERENCE IS THE BUG THIS CATCHES. Appearance → Type sets
     * `font-size` on <html> (apps/web/lib/appearance.ts), so every `rem` in the
     * cockpit is 13px..18px of root. The lights are parked by the OS at a fixed
     * point that knows nothing about it: `--titlebar-inset: 4.75rem` reserved
     * 66.5px at a 14px interface size for a group needing 76px, and the
     * wordmark slid into the green button. Window geometry is measured against
     * the window.
     */
    for (const name of ["--titlebar-inset", "--app-island-inset", "--titlebar-height"]) {
      for (const value of cssVarAll(name)) expect(value).toMatch(/^[\d.]+px$/);
    }
  });

  test("reserving width for the lights also means sitting on their centreline", () => {
    /**
     * THE HALF-DONE HEADER IS THE FAILURE THIS CATCHES, and it had already
     * happened: the right panel's tab bar takes the inset when it goes
     * fullscreen — it replaces the masthead as the window's top-left — but kept
     * a `h-10` of its own. 2.5rem matched the 40px band only at a 16px
     * interface size; at 14px it was 35px, centred 2.5px above the lights.
     *
     * FILE-LEVEL, not element-level: parsing which class list belongs to which
     * element out of TSX source is not worth the fragility. A file that knows
     * about the lights horizontally and says nothing about them vertically is
     * the smell, and it is enough to catch.
     */
    const fs = require("node:fs");
    const path = require("node:path");
    const web = path.join(__dirname, "..", "web", "components");
    const files = [];
    for (const dir of [web, path.join(web, "common"), path.join(web, "settings")]) {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".tsx")) files.push(path.join(dir, name));
      }
    }
    const reserves = files.filter((file) => fs.readFileSync(file, "utf8").includes("--titlebar-inset"));
    // If this drops to zero the walk broke and the test is asserting nothing.
    expect(reserves.length).toBeGreaterThan(2);
    for (const file of reserves) {
      const source = fs.readFileSync(file, "utf8");
      expect(source.includes("--titlebar-band-height"), `${path.basename(file)} reserves the traffic lights' width but never sets the band height`).toBe(true);
    }
  });
});

/** Pull a declared value out of the cockpit's stylesheet. */
function cssVar(pattern) {
  const found = pattern.exec(globalsCss());
  if (!found) throw new Error(`globals.css declares nothing matching ${pattern}`);
  return found[1];
}

/** Every value the stylesheet declares for one custom property. */
function cssVarAll(name) {
  const found = [...globalsCss().matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
  if (!found.length) throw new Error(`globals.css declares no ${name}`);
  return found;
}

/**
 * One custom property as declared INSIDE one selector's block.
 *
 * Naive, and deliberately so: the block is taken as the text from the selector
 * to the first `}`, which holds because these rules are flat declaration lists.
 * A nested rule would need a real parser — and would also be a sign this
 * contract had grown somewhere it should not have.
 */
function cssVarIn(selector, name) {
  const css = globalsCss();
  // `:root` opens several blocks in this stylesheet (theme tokens, then the
  // titlebar contract), so every block for the selector is searched and the
  // one that declares the property wins.
  const values = [];
  for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
    const found = new RegExp(`${name}:\\s*([^;]+);`).exec(css.slice(at, css.indexOf("}", at)));
    if (found) values.push(found[1].trim());
  }
  if (values.length !== 1) throw new Error(`${selector} declares ${name} ${values.length} times, expected once`);
  return values[0];
}

function globalsCss() {
  return require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "web", "app", "globals.css"), "utf8");
}
