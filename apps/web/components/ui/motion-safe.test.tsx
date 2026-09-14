/**
 * #247 — THE TWO PRIMITIVES THAT MOVE ON THEIR OWN RESPECT REDUCED MOTION.
 *
 * `Spinner` spins and `Skeleton` pulses without anybody asking them to, and
 * both did it regardless of `prefers-reduced-motion`. They are the primitives
 * every other surface reaches for — 41 spinner call sites, every skeleton — so
 * the prefix belongs on them rather than on each caller, and a caller that
 * passes its own `className` must not be able to lose it.
 *
 * RENDERED, NOT GREPPED: `cn` merges Tailwind classes and drops losers, so
 * "the source says motion-safe:" and "the DOM says motion-safe:" are different
 * claims and only the second one is what a reader with the setting on gets.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";

test("the spinner only spins when motion is welcome", () => {
  const html = renderToStaticMarkup(<Spinner />);
  expect(html).toContain("motion-safe:animate-spin");
  // The unguarded class is GONE, not merely joined by the guarded one — both
  // in the markup would animate for everyone.
  expect(html).not.toMatch(/class="[^"]*(^|\s)animate-spin/);
});

test("the skeleton only pulses when motion is welcome", () => {
  const html = renderToStaticMarkup(<Skeleton />);
  expect(html).toContain("motion-safe:animate-pulse");
  expect(html).not.toMatch(/class="[^"]*(^|\s)animate-pulse/);
});

test("a caller's own className cannot strip the guard", () => {
  // The common shape at the call sites: a size, passed in beside the default.
  expect(renderToStaticMarkup(<Spinner className="size-3" />)).toContain("motion-safe:animate-spin");
  expect(renderToStaticMarkup(<Skeleton className="h-4 w-24" />)).toContain("motion-safe:animate-pulse");
});
