/**
 * THE COMPOSER'S CORNERS, ON BOTH PLATFORMS.
 *
 * iOS eases the composer's corner from 27pt to 20pt when it gains focus: at
 * rest the box is a pill beside the send button, focused it is a card holding
 * seven lines, and a card at 27 reads as a lozenge. The web composer does not
 * move. Issue #250 item 12 asked which side should change, and the owner kept
 * the iOS behaviour — the animation was never the defect. The defect was that
 * 20 and 27 were bare literals at three call sites, in no scale, while a
 * `Theme.radiusComposer = 22` that nothing used sat in the token list.
 *
 * So this pins the outcome rather than the taste: the numbers have names, the
 * call sites reach for them, the dead 22 is gone, and the web composer is still
 * deliberately static. A future edit that "harmonises" the two platforms by
 * flattening the animation has to delete a test that says why it exists.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const theme = readFileSync(new URL("../../ios/TelarMobile/Views/Theme.swift", import.meta.url), "utf8");
const sessionView = readFileSync(new URL("../../ios/TelarMobile/Views/SessionView.swift", import.meta.url), "utf8");
const composer = readFileSync(new URL("../components/composer.tsx", import.meta.url), "utf8");

describe("iOS keeps the focus animation, on named radii", () => {
  test("both corners are tokens", () => {
    expect(theme).toContain("static let radiusComposerRest: CGFloat = 27");
    expect(theme).toContain("static let radiusComposerFocused: CGFloat = 20");
  });

  test("the unused 22 is gone", () => {
    expect(theme).not.toContain("radiusComposer:");
  });

  test("every call site reaches for them — no literal pair survives", () => {
    expect(sessionView).not.toMatch(/focused \? 20 : 27/);
    const named = sessionView.match(/focused \? Theme\.radiusComposerFocused : Theme\.radiusComposerRest/g) ?? [];
    // The glass, the hit target and the drop outline: three shapes, one pair of
    // numbers. A fourth shape that forgets one of them is the visible bug —
    // a drop outline that no longer traces the box it is outlining.
    expect(named).toHaveLength(3);
  });
});

describe("the web composer stays still, by decision", () => {
  test("its shell is the 18px rung", () => {
    expect(composer).toContain('"rounded-2xl border-border/80 bg-card/95 shadow-2 backdrop-blur-xl"');
  });

  test("and nothing animates its corner on focus", () => {
    expect(composer).not.toMatch(/focus-within:rounded/);
  });
});
