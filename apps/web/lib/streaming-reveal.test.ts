// @ts-expect-error bun:test is the test runner
import { expect, test } from "bun:test";
import { revealPrefix } from "./streaming-reveal";
test("stream pacing converges without changing text or splitting emoji", () => {
  const target = "Hello 👋 " + "streamed words ".repeat(20);
  let shown = "Hello ";
  for (let frame = 0; frame < 300; frame++) {
    shown = revealPrefix(shown, target, 16);
    expect(target.startsWith(shown)).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false);
  }
  expect(shown).toBe(target);
  expect(revealPrefix(shown, "corrected text", 16)).toBe("corrected text");
});
