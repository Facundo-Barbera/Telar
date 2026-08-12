// A MARKER NEVER SEVERS A STREAMING BLOCK (owner's live find on nightly .4).
// A completion marker landing mid-stream used to be appended after the open
// text part — and because a marker is main-thread (parentOf → undefined),
// the delta lookup's findLastIndex then hit the MARKER, orphaning the open
// part mid-word ("Two more verd") and restarting the block below. The fix
// inserts the live marker BEFORE the trailing open block, which both keeps
// the deltas merging and matches the persisted order (the projector pushes
// the marker at notification arrival and flushes the completed block after).
//
// Source pins, not DOM: this repo has no component harness by design, and
// the invariant is an ORDER decision in applyServerEvent's "marker" case.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../components/session/session-view.tsx", import.meta.url),
  "utf8",
);

describe("the live marker's landing spot", () => {
  test("an open trailing main-thread block pushes the marker ABOVE itself", () => {
    const markerCase = src.slice(
      src.indexOf('case "marker":'),
      src.indexOf('case "rolled_back":'),
    );
    expect(markerCase).toContain("parts.splice(parts.length - 1, 0, markerPart)");
    // The guard names all three conditions: open, block-typed, main-thread.
    expect(markerCase).toContain('(last.type === "text" || last.type === "thinking")');
    expect(markerCase).toContain("!last.done");
    expect(markerCase).toContain("parentOf(last) === undefined");
  });

  test("delta and finalize still target the trailing part of their own parent", () => {
    // The merge lookups the fix protects — if these move away from
    // findLastIndex-by-parent, the marker-order rule above must be
    // re-derived rather than silently kept.
    const matches = src.match(/findLastIndex\(\(p\) => parentOf\(p\) === parent\)/g);
    expect((matches?.length ?? 0) >= 2).toBe(true);
  });
});
