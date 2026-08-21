/**
 * The sentinel's diff logic.
 *
 * What is being protected is the "idle is free" property: a quiet project must
 * back off to one probe an hour, and a change must snap it straight back to
 * full attention. Both halves are asserted, plus the case that quietly breaks
 * everything if it is wrong — a first probe with no previous fingerprint.
 */
import { describe, expect, test } from "bun:test";
import { LoomProgram } from "@telar/engine-client";
import { digest, fingerprintFrom, hasChanged, nextInterval } from "../src/loom/sentinel";

const at = 1_700_000_000_000;
const DEFAULTS = LoomProgram.parse({}); // 300s → 3600s
const FAST = LoomProgram.parse({ watch: { intervalSec: 10, backoffMaxSec: 80 } });

describe("the digest", () => {
  test("is stable for the same input", () => {
    expect(digest("abc")).toBe(digest("abc"));
    expect(digest("")).toBe(digest(""));
  });

  test("distinguishes inputs that differ by one character", () => {
    expect(digest("9f8c1a2")).not.toBe(digest("9f8c1a3"));
    expect(digest("#457 2026-08-19")).not.toBe(digest("#457 2026-08-20"));
  });

  test("is hex, fixed width, and never empty", () => {
    for (const input of ["", "a", "a much longer probe line with spaces and , commas", "🧵"]) {
      expect(digest(input)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  test("handles unicode without collapsing it", () => {
    expect(digest("búsqueda")).not.toBe(digest("busqueda"));
  });
});

describe("fingerprintFrom", () => {
  test("keeps the probe line beside the hash, so a wrong answer is debuggable", () => {
    const fp = fingerprintFrom("9f8c1a2  -\n", at);
    expect(fp.probe).toBe("9f8c1a2  -");
    expect(fp.at).toBe(at);
    expect(fp.hash).toBe(digest("9f8c1a2  -"));
  });

  test("trailing whitespace is an artifact of the shell, not a change", () => {
    expect(fingerprintFrom("abc", at).hash).toBe(fingerprintFrom("  abc\n\n", at + 5).hash);
  });

  test("an empty probe output still produces a usable fingerprint", () => {
    const fp = fingerprintFrom("", at);
    expect(fp.hash).not.toBe("");
    expect(fp.probe).toBe("");
  });
});

describe("hasChanged", () => {
  test("no previous fingerprint counts as a change", () => {
    expect(hasChanged(null, fingerprintFrom("abc", at))).toBe(true);
    expect(hasChanged(undefined, fingerprintFrom("abc", at))).toBe(true);
  });

  test("same output, later timestamp, is not a change", () => {
    expect(hasChanged(fingerprintFrom("abc", at), fingerprintFrom("abc", at + 300_000))).toBe(false);
  });

  test("different output is a change", () => {
    expect(hasChanged(fingerprintFrom("abc", at), fingerprintFrom("abd", at + 1))).toBe(true);
  });
});

describe("nextInterval", () => {
  test("doubles on every quiet check", () => {
    expect(nextInterval(10, false, FAST)).toBe(20);
    expect(nextInterval(20, false, FAST)).toBe(40);
    expect(nextInterval(40, false, FAST)).toBe(80);
  });

  test("stops doubling at backoffMaxSec", () => {
    expect(nextInterval(80, false, FAST)).toBe(80);
    expect(nextInterval(1000, false, FAST)).toBe(80);
  });

  test("resets to the floor the moment anything changes", () => {
    expect(nextInterval(80, true, FAST)).toBe(10);
    expect(nextInterval(3600, true, DEFAULTS)).toBe(300);
  });

  test("a weekend of quiet converges on one probe an hour, and Monday resets it", () => {
    let interval = DEFAULTS.watch.intervalSec;
    for (let i = 0; i < 20; i++) interval = nextInterval(interval, false, DEFAULTS);
    expect(interval).toBe(3600);
    expect(nextInterval(interval, true, DEFAULTS)).toBe(300);
  });

  test("a current below the floor is clamped up, not doubled from garbage", () => {
    expect(nextInterval(0, false, FAST)).toBe(20);
    expect(nextInterval(-5, false, FAST)).toBe(20);
    expect(nextInterval(Number.NaN, false, FAST)).toBe(20);
    expect(nextInterval(1, false, FAST)).toBe(20);
  });

  test("a Program whose max is below its interval never goes under the interval", () => {
    const backwards = LoomProgram.parse({ watch: { intervalSec: 600, backoffMaxSec: 60 } });
    expect(nextInterval(600, false, backwards)).toBe(600);
    expect(nextInterval(600, true, backwards)).toBe(600);
  });
});
