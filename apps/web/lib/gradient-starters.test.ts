// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { isGradientValue } from "./backdrop";
import {
  composeGradient,
  GRADIENT_STARTERS,
  gradientStarterById,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  parseGradientCss,
  type GradientStarter,
} from "./gradient-starters";

/** The composer/parser round trip is tested in the protocol package; this covers the starter table. */
describe("GRADIENT_STARTERS", () => {
  // The store drops a value that fails isGradientValue silently, so a typo would ship unnoticed.
  test.each(GRADIENT_STARTERS.map((starter) => [starter.id, starter] as const))("%s composes to a value the store accepts", (_id: string, starter: GradientStarter) => {
    expect(isGradientValue(composeGradient(starter.light))).toBe(true);
    expect(isGradientValue(composeGradient(starter.dark))).toBe(true);
  });

  test("ids are unique and labels are present", () => {
    const ids = GRADIENT_STARTERS.map((starter) => starter.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const starter of GRADIENT_STARTERS) {
      expect(starter.id).toMatch(/^[a-z][a-z-]*$/);
      expect(starter.label.length).toBeGreaterThan(0);
    }
  });

  /** Stops must be inside the range the stop strip draws, and colours must be hex for the colour input. */
  test("every starter is something the editor can open and take apart", () => {
    for (const starter of GRADIENT_STARTERS) {
      for (const spec of [starter.light, starter.dark]) {
        expect(spec.stops.length).toBeGreaterThanOrEqual(MIN_GRADIENT_STOPS);
        expect(spec.stops.length).toBeLessThanOrEqual(MAX_GRADIENT_STOPS);
        for (const stop of spec.stops) {
          expect(stop.color).toMatch(/^#[0-9a-f]{6}$/);
          expect(stop.position).toBeGreaterThanOrEqual(0);
          expect(stop.position).toBeLessThanOrEqual(100);
        }
        // Round-trippable, so editing one stop does not reset the others.
        expect(parseGradientCss(composeGradient(spec))).toEqual(spec);
      }
    }
  });

  /** Light and dark halves differ, and migrating older preset layers relies on that. */
  test("light and dark are genuinely different", () => {
    for (const starter of GRADIENT_STARTERS) {
      expect(composeGradient(starter.light)).not.toBe(composeGradient(starter.dark));
    }
  });

  test("gradientStarterById finds them and misses cleanly", () => {
    expect(gradientStarterById("aurora")?.label).toBe("Aurora");
    expect(gradientStarterById("no-such-starter")).toBeUndefined();
  });
});
