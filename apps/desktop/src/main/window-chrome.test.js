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
    const insetPx = Number.parseFloat(cssVarIn('[data-telar-shell="macos"]', "--titlebar-inset"));

    const occupied = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_DIAMETER * 3 + 8 * 2;
    expect(insetPx).toBeGreaterThanOrEqual(occupied);
  });

  test("a browser tab reserves nothing — the inset is the shell's alone", () => {
    expect(cssVarIn(":root", "--titlebar-inset")).toBe("0px");
  });

  test("the renderer's header is the height the lights were centred in", () => {
    expect(Number(cssVar(/--titlebar-height:\s*([\d.]+)px/))).toBe(APP_HEADER_HEIGHT);
  });

  test("the window geometry is declared in px, never rem", () => {
    for (const name of ["--titlebar-inset", "--app-island-inset", "--titlebar-height"]) {
      for (const value of cssVarAll(name)) expect(value).toMatch(/^[\d.]+px$/);
    }
  });

  test("reserving width for the lights also means sitting on their centreline", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const web = path.join(__dirname, "..", "..", "..", "web", "src", "components");
    const files = [];
    for (const dir of [web, path.join(web, "common"), path.join(web, "settings")]) {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".tsx")) files.push(path.join(dir, name));
      }
    }
    const reserves = files.filter((file) => fs.readFileSync(file, "utf8").includes("--titlebar-inset"));

    expect(reserves.length).toBeGreaterThan(2);
    for (const file of reserves) {
      const source = fs.readFileSync(file, "utf8");
      expect(source.includes("--titlebar-band-height"), `${path.basename(file)} reserves the traffic lights' width but never sets the band height`).toBe(true);
    }
  });
});

function cssVar(pattern) {
  const found = pattern.exec(globalsCss());
  if (!found) throw new Error(`globals.css declares nothing matching ${pattern}`);
  return found[1];
}

function cssVarAll(name) {
  const found = [...globalsCss().matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
  if (!found.length) throw new Error(`globals.css declares no ${name}`);
  return found;
}

function cssVarIn(selector, name) {
  const css = globalsCss();

  const values = [];
  for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
    const found = new RegExp(`${name}:\\s*([^;]+);`).exec(css.slice(at, css.indexOf("}", at)));
    if (found) values.push(found[1].trim());
  }
  if (values.length !== 1) throw new Error(`${selector} declares ${name} ${values.length} times, expected once`);
  return values[0];
}

function globalsCss() {
  return require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "..", "web", "src", "app", "globals.css"), "utf8");
}
