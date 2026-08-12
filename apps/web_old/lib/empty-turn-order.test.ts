// The empty-turn forensics' ORDER invariant (the aliasing bug of 2026-08-08):
// store.appendTurn MUTATES the shared `parts` array — it pushes the attention
// marker into an empty response — so the route's emptiness check must be
// MEASURED BEFORE appendTurn runs or the live marker event and the
// diagnostics write skip in exactly the case they exist for. The first real
// empty-turn catch proved it: marker persisted, diagnostics.ndjson empty.
// Static scan, own narrow file — same idioms and same merge-awareness
// argument as spawn-reveal.test.ts.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../app/api/chat/route.ts", import.meta.url),
  "utf8",
);

describe("the empty-turn check is measured before the store can mutate the evidence", () => {
  test("turnEndedEmpty is captured BEFORE the main appendTurn call", () => {
    const captureAt = src.indexOf("const turnEndedEmpty = !hiddenTurn && parts.length === 0;");
    const persistAt = src.indexOf('assistantMessage: { role: "assistant", parts }');
    expect(captureAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(-1);
    expect(captureAt).toBeLessThan(persistAt);
  });

  test("the marker event and the diagnostics both key off the pre-measured flag", () => {
    const branchAt = src.indexOf("if (turnEndedEmpty) {");
    expect(branchAt).toBeGreaterThan(-1);
    const branch = src.slice(branchAt, branchAt + 1600);
    expect(branch).toContain("send(\"marker\", { text: EMPTY_TURN_MARKER");
    expect(branch).toContain("appendSessionDiagnostic(capturedSession");
    // And no live check reads parts.length after the persist — the mutated
    // array is exactly the wrong witness.
    expect(src).not.toContain("if (!hiddenTurn && parts.length === 0) {");
  });
});
