// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Spinner } from "./spinner";

test("the spinner only spins when motion is welcome", () => {
  const html = renderToStaticMarkup(<Spinner />);
  expect(html).toContain("motion-safe:animate-spin");
  // Both classes in the markup would animate for everyone.
  expect(html).not.toMatch(/class="[^"]*(^|\s)animate-spin/);
});

test("a caller's own className cannot strip the guard", () => {
  expect(renderToStaticMarkup(<Spinner className="size-3" />)).toContain("motion-safe:animate-spin");
});
