// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { cssFontFamilies, parseAppearance, DEFAULT_APPEARANCE } from "./appearance";

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
});
