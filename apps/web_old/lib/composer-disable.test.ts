// Issue #14 — the composer must go quiet, with a reason, exactly while the
// Ultra pane owns the whole screen. A static scan of `session-view.tsx`, in
// the same style `ultra-runs.test.ts`'s bottom section and
// `right-panel-mount.test.ts` already use for claims a DOM-less test suite
// cannot otherwise prove: this repo has no component harness (story 3.1 hard
// rule 9), so the SOURCE TEXT is the executable form of "this prop is wired
// to that gate".
//
// KEPT IN ITS OWN FILE rather than folded into `right-panel-mount.test.ts` or
// `ultra-runs.test.ts`: both `session-view.tsx` and its composer are named in
// this branch's merge-awareness note as places two sibling branches are also
// editing. A new, narrowly-scoped test file is far less likely to conflict
// than one more assertion stitched into an existing describe block those
// branches may also be touching.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("issue #14 — disable the composer while the Ultra view owns the screen", () => {
  test("the gate is fullscreen + Activity tab + an actual Ultra run, not merely the dock being open", () => {
    const src = read("components/session/session-view.tsx");
    // Side-by-side (the dock open but not fullscreen) is exactly what #13(b)
    // fixed to be unambiguous — disabling in that case would regress it.
    expect(src).toContain("rightPanelSession.fullscreen &&");
    expect(src).toContain("rightPanelSession.activeTabId === DEFAULT_ACTIVITY_TAB.id &&");
    expect(src).toContain("activeRunTab !== null;");
    expect(src).toContain("const ultraOwnsScreen =");
  });

  test("both halves of the composer — typing and sending — are actually disabled", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).toContain("disabled={ultraOwnsScreen}");
    // Two call sites are expected: PromptInputTextarea and PromptInputSubmit.
    // A single occurrence would mean one of the two still accepts input.
    expect(src.split("disabled={ultraOwnsScreen}").length - 1).toBe(2);
  });

  test("the reason names WHERE the composer went, not just that it is off", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).toContain("ultraOwnsScreen\n                      ? \"Exit fullscreen to send a message to this session…\"");
  });
});
