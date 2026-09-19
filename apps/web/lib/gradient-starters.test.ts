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

/** The composer/parser round trip itself lives in the protocol package, where
 *  the spec does — this file is about the TABLE: that every starter is a
 *  gradient this build can paint, show and hand to the editor. */
describe("GRADIENT_STARTERS", () => {
  // The store's gate is SILENT: a value that fails isGradientValue is dropped
  // rather than rejected, so a typo in a starter would ship as "clicking this
  // one does nothing". This is the test that makes it loud.
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

  /** A CHIP HAS TO FILL AN EDITOR, which is the whole point of a starter now:
   *  its stops have to be inside the range the stop strip can draw, and its
   *  colours have to be hex or the colour input cannot show them. */
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
        // Round-trippable, which is what makes "start from Dusk, then change
        // one stop" work rather than silently resetting the others.
        expect(parseGradientCss(composeGradient(spec))).toEqual(spec);
      }
    }
  });

  /** The two halves are what makes a starter worth having two of: a wash tuned
   *  for daylight is not the one that reads at night, and the migration of an
   *  older preset layer leans on the difference. */
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
