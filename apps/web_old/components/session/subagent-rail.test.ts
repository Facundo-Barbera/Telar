// The rail publishes a run count on its COLLAPSED EDGE that it does not own.
//
// `workflows` reaches `SubagentRail` pre-rendered, so the component cannot count
// what it is about to draw; the caller hands it `workflowCount` separately. That
// makes the collapsed edge and `ultra-rail.tsx`'s own header two independent
// prints of one number, with nothing structural holding them together. These
// scans are that missing structure.
//
// STATIC TEXT SCANS, deliberately: there is no component test harness in this
// repo and story 3.1's hard rule 9 forbids introducing one, so a claim about
// wiring is asserted the way `ultra-runs.test.ts` asserts its own — by reading
// source. They are expected to FIRE when the Workflows section is split into
// live and settled groups; the fix then is to move BOTH counts, not to relax
// the scan.

// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath(import.meta.url)` and not `import.meta.dir`: the latter is a
// Bun extension the web tsconfig cannot type.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const readSource = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("the Workflows count is honest on both surfaces", () => {
  test("the collapsed edge and the Workflows header count the SAME list", () => {
    const view = readSource("apps/web/components/session/session-view.tsx");
    // One list feeds the section and the count beside it. If either side is
    // ever narrowed to live runs alone, the other silently keeps meaning "all".
    expect(view).toMatch(/runs=\{\s*ultraRunList\s*\}/);
    expect(view).toMatch(/workflowCount=\{\s*ultraRunList\.length\s*\}/);
  });

  test("the Workflows header prints its total unfiltered", () => {
    const rail = readSource("apps/web/components/session/ultra-rail.tsx");
    // `runs.length`, not a filtered length — the header's right-hand total is
    // the number the collapsed edge repeats.
    expect(rail).toContain("{runs.length}");
  });

  test("both readers inside the rail take the count from the one prop", () => {
    const rail = readSource("apps/web/components/session/subagent-rail.tsx");
    expect(rail).toContain("workflows={workflowCount}"); // the collapsed edge
    expect(rail).toContain("(workflowCount ?? 0) === 0"); // the empty state
  });
});
