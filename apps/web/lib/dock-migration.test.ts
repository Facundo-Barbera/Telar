// The dock migration, completed (owner's direction, 2026-08-07): the main
// chat stays the main chat, and EVERY secondary display — Ultra runs since
// issue #13, sub-agent conversations as of this change — opens in the right
// panel's activity slot as a sibling, never as a replacement. Static scans,
// same style and same reason as spawn-reveal.test.ts: no DOM harness exists
// to click a spawn row and watch the main column for a lack of movement.
//
// OWN FILE, not folded into spawn-reveal.test.ts: same merge-awareness
// argument that file makes for itself — session-view.tsx is hot, and a new
// narrow file conflicts less than one more assertion in a shared describe.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("a sub-agent's conversation renders in the dock, never in place of Main", () => {
  test("the Main-column takeover is gone: transcriptItems has no bucket short-circuit", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).not.toContain("if (activeBucket) return [agentBucketItem");
  });

  test("Main's scroll is Main's alone — never keyed by a bucket, never bucket-live", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).toContain('scrollKey="main"');
    expect(src).not.toContain("scrollKey={activeBucket");
    expect(src).not.toContain("live={activeBucket");
  });

  test("the activity slot has the bucket arm, rendered through the same item + registry Main used", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).toContain(") : activeBucket ? (");
    expect(src).toContain("items={[agentBucketItem(activeBucket");
  });

  test("selecting from Main reveals the dock — a hidden pane would make the click do nothing", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).toContain("onSelectAgent: openAgentInDock");
    // The reveal is a USER gesture handler, not a spawn effect — issue #18's
    // rule (no spawn-driven reveal) still holds and its own test still pins it.
    expect(src).toContain("openRightPanelActivity(resolvedRightPanelScopeKey);\n    },\n    [resolvedRightPanelScopeKey],");
  });
});
