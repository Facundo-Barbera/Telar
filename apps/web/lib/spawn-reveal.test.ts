// Issue #18 — spawning a subagent must not rearrange the screen. Traced
// mechanism (see the comment left in `session-view.tsx` at the removal site):
// ONE effect used to call both `setActiveTab(started.id)` (hijacking the main
// transcript — the same swap mechanism #13(b) removed for Ultra runs) and
// `setWorkspaceInspectorOpen(true)` (forcing the pinned env open) the instant
// any spawn's tool_result first arrived, with no gate on whether a human was
// looking for it. This is a static scan, in the same style as
// `right-panel-mount.test.ts` and `ultra-runs.test.ts`'s bottom section,
// because there is no DOM harness in this repo to click "spawn" and watch
// three panes for a lack of movement.
//
// OWN FILE, not folded into `right-panel-mount.test.ts` or
// `sidebar-mount.test.ts`: `session-view.tsx` is named in this branch's
// merge-awareness note as a file two sibling branches are concurrently
// editing, and a new narrow file conflicts far less than one more assertion
// inside a shared describe block.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

describe("issue #18 — a spawned subagent stays backgrounded until a human goes looking", () => {
  test("the traced cascade is gone: no spawn-driven setActiveTab or forced-open of the pinned env", () => {
    const src = read("components/session/session-view.tsx");
    expect(src).not.toContain("setActiveTab(started.id)");
    expect(src).not.toContain("setWorkspaceInspectorOpen(true)");
    // The two SURVIVING call sites for `setWorkspaceInspectorOpen` are its
    // `useState` initializer (`false`) and the inspector's own controlled
    // `onOpenChange` wiring — neither fires on a spawn.
    expect(src).toContain("const [workspaceInspectorOpen, setWorkspaceInspectorOpen] = useState(false);");
    expect(src).toContain("onOpenChange={setWorkspaceInspectorOpen}");
  });

  test("the quiet indicator #17 asked for is untouched: still derived, never gated on a fresh spawn", () => {
    const inspector = read("components/session/workspace-inspector.tsx");
    // Reactive to CURRENT state, not to a transition — so it stays lit for the
    // whole time an agent is live, exactly the "read as active" #17 asked for,
    // and is never the thing that pops the panel open. The derivation moved
    // from `agents.some(status === "running")` to the LIVE-ONLY lists the
    // pinned environment now renders (issue #47); it is the same predicate over
    // the same current state, plus the background-task roster, which is live by
    // construction.
    expect(inspector).toContain("const liveAgents = agents.filter((agent) => agent.status === \"running\");");
    expect(inspector).toContain(
      "liveAgents.length > 0 || liveWorkflows.length > 0 || tasks.length > 0;",
    );
    expect(inspector).toContain("(needsAttention || activityRunning) && (");
  });
});
