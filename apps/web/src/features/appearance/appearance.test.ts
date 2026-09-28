import { describe, expect, test } from "bun:test";
import { APPEARANCE_INIT_SCRIPT, cssFontFamilies, parseAppearance, DEFAULT_APPEARANCE, DEPTHS } from "./appearance";

describe("cssFontFamilies", () => {
  test("leaves a bare ident unquoted", () => {
    expect(cssFontFamilies("Menlo")).toBe("Menlo");
  });

  test("quotes names CSS would not accept bare", () => {
    expect(cssFontFamilies("SF Mono")).toBe('"SF Mono"');
    expect(cssFontFamilies("2Zero")).toBe('"2Zero"');
  });

  test("keeps a name the reader already quoted", () => {
    expect(cssFontFamilies("'SF Mono'")).toBe("'SF Mono'");
  });

  test("splits a list and drops the empties around stray commas", () => {
    expect(cssFontFamilies("SF Mono, , Menlo,")).toBe('"SF Mono", Menlo');
  });

  // A quote inside the value could close the declaration and let anything
  // after it through, so it is removed rather than escaped.
  test("strips embedded double-quotes", () => {
    expect(cssFontFamilies('Ev"il; color:red')).toBe('"Evil; color:red"');
  });

  test("answers null for input that is effectively empty", () => {
    expect(cssFontFamilies("")).toBeNull();
    expect(cssFontFamilies("   ")).toBeNull();
    expect(cssFontFamilies(",,")).toBeNull();
  });
});

describe("parseAppearance", () => {
  test("falls to the defaults on nothing at all", () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("not json")).toEqual(DEFAULT_APPEARANCE);
  });

  test("keeps a custom choice and its family", () => {
    const parsed = parseAppearance(JSON.stringify({ fontSans: "custom", fontSansCustom: "SF Pro", fontMono: "custom", fontMonoCustom: "Berkeley Mono" }));
    expect(parsed.fontSans).toBe("custom");
    expect(parsed.fontSansCustom).toBe("SF Pro");
    expect(parsed.fontMono).toBe("custom");
    expect(parsed.fontMonoCustom).toBe("Berkeley Mono");
  });

  test("an unrecognised family name falls back rather than wedging the store", () => {
    expect(parseAppearance(JSON.stringify({ fontSans: "comic" })).fontSans).toBe("geist");
    expect(parseAppearance(JSON.stringify({ fontMono: 7 })).fontMono).toBe("geist");
    expect(parseAppearance(JSON.stringify({ fontSansCustom: 12 })).fontSansCustom).toBe("");
  });

  test("clamps a font size into range and rounds it", () => {
    expect(parseAppearance(JSON.stringify({ fontSize: 4 })).fontSize).toBe(13);
    expect(parseAppearance(JSON.stringify({ fontSize: 99 })).fontSize).toBe(18);
    expect(parseAppearance(JSON.stringify({ fontSize: 14.6 })).fontSize).toBe(15);
  });

  test("a non-numeric font size is the default, not NaN", () => {
    expect(parseAppearance(JSON.stringify({ fontSize: "big" })).fontSize).toBe(16);
    expect(parseAppearance(JSON.stringify({ fontSize: null })).fontSize).toBe(16);
  });

  test("keeps a depth it recognises", () => {
    expect(parseAppearance(JSON.stringify({ depth: "flat" })).depth).toBe("flat");
    expect(parseAppearance(JSON.stringify({ depth: "deep" })).depth).toBe("deep");
  });

  test("a missing or unrecognised depth is soft", () => {
    expect(parseAppearance("{}").depth).toBe("soft");
    expect(parseAppearance(JSON.stringify({ depth: "deeper" })).depth).toBe("soft");
    expect(parseAppearance(JSON.stringify({ depth: 3 })).depth).toBe("soft");
    expect(parseAppearance(null).depth).toBe("soft");
  });
});

/** The pre-paint script is a separate dependency-free parser inlined in <head>; these run it and read the attributes back. */
describe("APPEARANCE_INIT_SCRIPT and data-depth", () => {
  function runWith(stored: unknown): { get: (name: string) => string | null } {
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      style: { setProperty() {}, removeProperty() {}, fontSize: "" },
    };
    const scope = {
      localStorage: { getItem: (key: string) => (key === "telar-appearance" ? JSON.stringify(stored) : null) },
      document: { documentElement: element, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    };
    new Function("localStorage", "document", APPEARANCE_INIT_SCRIPT)(scope.localStorage, scope.document);
    return { get: (name: string) => attributes.get(name) ?? null };
  }

  test("writes the attribute for a non-default depth", () => {
    expect(runWith({ depth: "deep" }).get("data-depth")).toBe("deep");
    expect(runWith({ depth: "flat" }).get("data-depth")).toBe("flat");
  });

  // The default writes nothing so globals.css stays the single source of the default look.
  test("writes nothing for soft, for a missing value, or for junk", () => {
    expect(runWith({ depth: "soft" }).get("data-depth")).toBeNull();
    expect(runWith({}).get("data-depth")).toBeNull();
    expect(runWith({ depth: "deeeep" }).get("data-depth")).toBeNull();
  });

  // The script decides "is this the default?" by comparing against element
  // zero of the list it is handed, so the order of DEPTHS is load-bearing.
  test("the default is first in DEPTHS, which is what the script relies on", () => {
    expect<string>(DEPTHS[0]).toBe(DEFAULT_APPEARANCE.depth);
  });
});
