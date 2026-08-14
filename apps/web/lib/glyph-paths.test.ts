// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { chipGlyphFor } from "./glyph-paths";
import {
  checkReference,
  directoryReference,
  fileReference,
  issueReference,
  pageReference,
  pullReference,
  taskReference,
  type ReferenceKind,
} from "./drag-reference";

/** One of every kind `drag-reference.ts` can produce. The point of the list is
 *  that it is exhaustive — a seventh kind added there fails the count below. */
const EVERY_KIND: Record<ReferenceKind, ReturnType<typeof fileReference>> = {
  file: fileReference("apps/engine/src/driver.ts"),
  issue: issueReference({ number: 1, title: "t", url: "https://example.test/i/1" }),
  pull: pullReference({ number: 2, title: "t", url: "https://example.test/p/2" }),
  page: pageReference({ url: "https://example.test/" }),
  task: taskReference({ id: "task_a", title: "Audit", state: "completed" }),
  check: checkReference({ name: "typecheck", status: "completed", conclusion: "failure" }),
};

describe("a chip can draw every reference there is", () => {
  test("every kind resolves to markup and a colour", () => {
    // An unresolved glyph renders an empty box in the middle of a sentence,
    // which is the failure this exists to catch.
    for (const [kind, reference] of Object.entries(EVERY_KIND)) {
      const glyph = chipGlyphFor(reference);
      expect(glyph.markup.length, `${kind} has markup`).toBeGreaterThan(0);
      expect(glyph.tint.length, `${kind} has a tint`).toBeGreaterThan(0);
    }
    expect(Object.keys(EVERY_KIND)).toHaveLength(6);
  });

  test("a file asks the second question and a directory does not", () => {
    // A `.ts` and a `.png` are not "a file" twice; an issue is just an issue.
    const typescript = chipGlyphFor(fileReference("src/a.ts"));
    const image = chipGlyphFor(fileReference("docs/shot.png"));
    expect(typescript.markup).not.toBe(image.markup);
    expect(chipGlyphFor(directoryReference("apps/engine"))).toEqual(chipGlyphFor(directoryReference("packages/core")));
  });
});
