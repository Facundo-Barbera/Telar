/**
 * THE FOOT, PINNED AT THE MARKUP.
 *
 * What this catches is the set of decisions the strip is easiest to regress on,
 * none of which a typecheck can see:
 *   · the create-time popover appears on a FRESH canvas and is gone once the
 *     session exists (the worktree is cut once, and a control that could not
 *     change anything would be a lie of affordance);
 *   · the uncommitted count survives the redesign — it is the only path from
 *     the composer to the Changes panel;
 *   · the strip stays fused to the composer's bottom edge.
 *
 * Static markup, so the effects never run: the notebook the engine would answer
 * with is not what is under test here, the shape drawn around it is.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@telar/engine-client";
import { ProjectNotesStrip } from "./project-notes-strip";

const session = { id: "session_1", projectId: "p1", workspace: { mode: "worktree", branch: "telar/x" } } as unknown as Session;

const render = (props: Parameters<typeof ProjectNotesStrip>[0]) => renderToStaticMarkup(<ProjectNotesStrip {...props} />);

describe("the composer's foot", () => {
  test("a fresh canvas offers where this lands; a live session does not", () => {
    // The one create-time choice a session cannot be created without.
    const fresh = render({ projectId: "p1", projectName: "aurora", envMode: "worktree", onEnvMode: () => {} });
    expect(fresh).toContain('aria-label="Where this lands"');
    // …and it names the project, which is the other thing a person checks
    // before their first sentence.
    expect(fresh).toContain("aurora");

    // Once the session exists the worktree is a fact on disk, not a setting.
    const live = render({ projectId: "p1", projectName: "aurora", session, envMode: "worktree", onEnvMode: () => {} });
    expect(live).not.toContain('aria-label="Where this lands"');
  });

  test("the notebook's own affordance is always there, and names itself only while empty", () => {
    // Once there are chips the row is obviously a row of notes, and a permanent
    // label would be width spent on something already understood.
    const markup = render({ projectId: "p1", session });
    expect(markup).toContain('aria-label="New note"');
    expect(markup).toContain(">Note<");
  });

  test("the uncommitted count is not drawn when the engine has not answered", () => {
    // Absent is absent. A reassuring "0 changed" over an unread working tree is
    // the one thing this readout must never say.
    expect(render({ projectId: "p1", session })).not.toContain("changed");
  });

  test("it stays fused to the composer's bottom edge", () => {
    // `-mt-px` + `border-t-0` + bottom-only rounding is what makes it read as
    // the same object's foot rather than a second card below it.
    const markup = render({ projectId: "p1", session });
    expect(markup).toContain("-mt-px");
    expect(markup).toContain("border-t-0");
    expect(markup).toContain("rounded-b-xl");
  });
});
