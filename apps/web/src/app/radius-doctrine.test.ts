/**
 * THE LADDER THE STYLESHEET DESCRIBES HAS TO BE THE LADDER IT SHIPS.
 *
 * `globals.css` argues for itself at length, which is most of why this codebase
 * is navigable — and it is also a liability, because prose does not compile. The
 * radius comment said "18px cards and dialogs" while the app drew every card at
 * 14px, and it said so for long enough that iOS was ported from the practice
 * (`Theme.radiusCard = 14`) rather than from the paragraph. Nothing failed. The
 * next person to read it simply got a wrong answer from the most authoritative
 * place they could have looked.
 *
 * Issue #250 item 13 was the fork: correct the doctrine, or migrate 58 sites to
 * match it. The owner corrected the doctrine — it was the side that disagreed
 * with both platforms. This file is what stops that from rotting a second time.
 *
 * IT CHECKS THE CLAIM AGAINST THE TREE, not against a copy of the claim. The
 * rung each sentence names is computed from `--radius`, so retuning the scale
 * fails here rather than silently making the paragraph wrong again; and the card
 * rung is checked against which utility the components actually reach for, so a
 * future migration to 18px cards trips this test and has to update the prose it
 * is contradicting. That is the whole point: whichever side moves, the two move
 * together.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../../../ios/TelarMobile/UI/Theme.swift", import.meta.url), "utf8");

/** The base the whole scale derives from, in px. */
const BASE = Number(/--radius:\s*([\d.]+)rem;/.exec(css)?.[1]) * 16;

/**
 * A rung's computed px, read from its own declaration rather than assumed.
 *
 * `--radius-lg` is the base itself (`var(--radius)`, no multiplier) because the
 * scale is anchored there — every other rung is a ratio against it. Reading the
 * multiplier out of the file rather than hardcoding the ladder is the point: a
 * retune of `--radius` moves all five together and this still holds.
 */
function rung(name: string): number {
  const declaration = new RegExp(`--radius-${name}: ([^;]+);`).exec(css);
  expect(declaration, `--radius-${name} is declared`).not.toBeNull();
  const value = declaration![1];
  if (value === "var(--radius)") return BASE;
  const multiplier = /calc\(var\(--radius\) \* ([\d.]+)\)/.exec(value);
  expect(multiplier, `--radius-${name} derives from --radius`).not.toBeNull();
  return BASE * Number(multiplier![1]);
}

describe("the base, and the rungs the doctrine names", () => {
  test("--radius is 10px", () => {
    expect(BASE).toBeCloseTo(10, 5);
  });

  test("controls are 8px", () => {
    expect(rung("md")).toBeCloseTo(8, 5);
  });

  test("fields and popovers are 10px", () => {
    expect(rung("lg")).toBeCloseTo(10, 5);
  });

  test("cards are 14px", () => {
    expect(rung("xl")).toBeCloseTo(14, 5);
  });

  test("dialogs and the composer are 18px", () => {
    expect(rung("2xl")).toBeCloseTo(18, 5);
  });
});
describe("the two platforms agree about a card", () => {
  test("iOS carries the same 14", () => {
    expect(theme).toContain("static let radiusCard: CGFloat = 14");
    expect(rung("xl")).toBeCloseTo(14, 5);
  });
});

describe("--control-radius, the reason nobody noticed", () => {
  test("it is authored at 8px, not derived", () => {
    expect(css).toContain("--control-radius: 0.5rem;");
  });

  test("which is the same 8px --radius-md computes to — hence zero call sites", () => {
    expect(rung("md")).toBeCloseTo(0.5 * 16, 5);
  });
});
