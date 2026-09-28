// `multi` shows as AUTO, matching the picker's "Automatic".
import { describe, expect, test } from "bun:test";
import { DICTATION_AUTOMATIC } from "./automatic";
import { DICTATION_AUTOMATIC_BADGE, languageBadge } from "./language-label";

describe("languageBadge", () => {
  test("a language code is its own name, upper-cased", () => {
    expect(languageBadge("es")).toBe("ES");
    expect(languageBadge("ja")).toBe("JA");
    // PT and PT-BR are different rows in the picker.
    expect(languageBadge("pt-BR")).toBe("PT-BR");
    expect(languageBadge("es-419")).toBe("ES-419");
  });

  test("`multi` reads as AUTO, which is what the picker calls it", () => {
    expect(languageBadge(DICTATION_AUTOMATIC)).toBe("AUTO");
    expect(languageBadge(DICTATION_AUTOMATIC)).toBe(DICTATION_AUTOMATIC_BADGE);
    expect(languageBadge(DICTATION_AUTOMATIC)).not.toBe("MULTI");
  });

  test("an empty code reads as AUTO rather than as an empty badge", () => {
    expect(languageBadge("")).toBe("AUTO");
    expect(languageBadge("   ")).toBe("AUTO");
  });
});
