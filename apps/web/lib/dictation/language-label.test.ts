/**
 * THE BADGE AT THE CARET SAYS THE LANGUAGE (#561).
 *
 * Small surface, three rules, and the middle one is the only one somebody would
 * get wrong twice: `multi` is shown as AUTO rather than as MULTI, because the
 * picker calls it "Automatic" and a third name for one setting is a name the
 * reader has never seen.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { DICTATION_AUTOMATIC } from "./automatic";
import { DICTATION_AUTOMATIC_BADGE, languageBadge } from "./language-label";

describe("languageBadge", () => {
  test("a language code is its own name, upper-cased", () => {
    expect(languageBadge("es")).toBe("ES");
    expect(languageBadge("ja")).toBe("JA");
    // A regional variant keeps its region — PT and PT-BR are different rows in
    // the picker, and a badge that flattened them would be lying about which.
    expect(languageBadge("pt-BR")).toBe("PT-BR");
    expect(languageBadge("es-419")).toBe("ES-419");
  });

  test("`multi` reads as AUTO, which is what the picker calls it", () => {
    expect(languageBadge(DICTATION_AUTOMATIC)).toBe("AUTO");
    expect(languageBadge(DICTATION_AUTOMATIC)).toBe(DICTATION_AUTOMATIC_BADGE);
    // NOT "MULTI". The code is the vendor's word; this badge speaks the
    // setting's.
    expect(languageBadge(DICTATION_AUTOMATIC)).not.toBe("MULTI");
  });

  test("an empty code reads as AUTO rather than as an empty badge", () => {
    // It should not happen — the engine answers `multi` for a Mac that has
    // never been told — but a pill with nothing in it is a worse way to find
    // that out than one naming what will actually be transcribed.
    expect(languageBadge("")).toBe("AUTO");
    expect(languageBadge("   ")).toBe("AUTO");
  });
});
