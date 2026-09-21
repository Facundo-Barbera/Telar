/**
 * THE FOOT, PINNED AT THE MARKUP.
 *
 * What this catches is the set of decisions the strip is easiest to regress on,
 * none of which a typecheck can see:
 *   · a LIVE SESSION'S foot names its branch and says how much is uncommitted —
 *     the two facts a person checks before pressing Enter, and the pair #258
 *     removed;
 *   · a FRESH CANVAS offers the create-time choice instead, and only there: the
 *     worktree is cut once, and a control that could not change anything would
 *     be a lie of affordance;
 *   · the strip stays fused to the composer's bottom edge.
 *
 * `EnvironmentStrip`, not `WorkspaceEnvironment`: the git readout arrives over a
 * poll, and a static render never runs the effect that starts it. The strip is
 * the half that decides what a reader sees, so it is the half handed the answer.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitOverview, GitRefEntry, Session } from "@telar/engine-client";
import { BaseRefPicker, EnvironmentStrip } from "./workspace-environment";

const session = { id: "session_1", projectId: "p1", workspace: { mode: "worktree", branch: "telar/x" } } as unknown as Session;

const git = (extra: Partial<GitOverview> = {}): GitOverview =>
  ({ repository: true, branch: "main", dirtyFiles: 3, ahead: 2, behind: 1, worktrees: [], ...extra }) as GitOverview;

const render = (props: Parameters<typeof EnvironmentStrip>[0]) => renderToStaticMarkup(<EnvironmentStrip {...props} />);

describe("the composer's foot", () => {
  test("a live session names the project, the checkout and the branch, and counts what is uncommitted", () => {
    const markup = render({ projectId: "p1", projectName: "aurora", session, git: git() });
    expect(markup).toContain("aurora");
    // A worktree session works on its OWN branch — the repository's HEAD would
    // be actively misleading, so the session's branch wins over git's.
    expect(markup).toContain("telar/x");
    expect(markup).not.toContain(">main<");
    expect(markup).toContain("Own worktree");
    expect(markup).toContain("3 changed");
  });

  test("a session on the project's own checkout says so, and takes git's branch", () => {
    const local = { ...session, workspace: { mode: "local" } } as unknown as Session;
    const markup = render({ projectId: "p1", session: local, git: git() });
    expect(markup).toContain("Project checkout");
    expect(markup).toContain("main");
  });

  test("the uncommitted count is not drawn when the engine has not answered", () => {
    // Absent is absent. A reassuring "0 changed" over an unread working tree is
    // the one thing this readout must never say.
    expect(render({ projectId: "p1", session })).not.toContain("changed");
    expect(render({ projectId: "p1", session, git: git({ dirtyFiles: 0 }) })).not.toContain("changed");
  });

  test("a fresh canvas offers where this lands; a live session does not", () => {
    const fresh = render({ projectId: "p1", projectName: "aurora", envMode: "worktree", onEnvMode: () => {} });
    expect(fresh).toContain('aria-label="Where this lands"');
    expect(fresh).toContain("aurora");
    // Once the session exists the worktree is a fact on disk, not a setting.
    const live = render({ projectId: "p1", projectName: "aurora", session, envMode: "worktree", onEnvMode: () => {} });
    expect(live).not.toContain('aria-label="Where this lands"');
    expect(live).toContain('aria-label="Branch"');
  });

  test("it stays fused to the composer's bottom edge", () => {
    // `-mt-px` + `border-t-0` + bottom-only rounding is what makes it read as
    // the same object's foot rather than a second card below it.
    const markup = render({ projectId: "p1", session });
    expect(markup).toContain("-mt-px");
    expect(markup).toContain("border-t-0");
    expect(markup).toContain("rounded-b-2xl");
  });
});

/**
 * THE BASE PICKER, ON A LISTING THAT IS NOT THE REPOSITORY — issue #650.
 *
 * The engine change alone does not fix this bug. `refsIncomplete` reaching the
 * client is worth nothing if the picker draws a timed-out listing exactly as it
 * draws a repository with no branches: the person still reads a short list as
 * complete and cuts their session from a base they did not mean. What is pinned
 * here is that the two are DIFFERENT SENTENCES, and that the timeout carries
 * something a person can do about it.
 */
describe("the base-ref picker when git did not answer", () => {
  const refs: GitRefEntry[] = [{ name: "origin/main", kind: "remote" }];
  const picker = (props: Partial<Parameters<typeof BaseRefPicker>[0]> = {}) =>
    renderToStaticMarkup(<BaseRefPicker refs={refs} pending={{}} onBase={() => {}} {...props} />);

  test("a whole listing says nothing — no notice on the ordinary path", () => {
    const markup = picker();
    expect(markup).not.toContain("did not answer");
    expect(markup).not.toContain("Ask git again");
  });

  test("a timed-out listing says git did not answer, and offers to ask again", () => {
    const markup = picker({ incomplete: "timeout", onRetry: () => {} });
    expect(markup).toContain("did not answer in time");
    expect(markup).toContain("missing branches");
    // Retry is the honest offer: the machine was busy, the answer may differ.
    expect(markup).toContain("Ask git again");
  });

  test("a listing that failed for another reason is a different sentence", () => {
    // Retrying a repository git cannot read is not the same promise as retrying
    // a machine under load, so the prose must not claim it is.
    const markup = picker({ incomplete: "failed", onRetry: () => {} });
    expect(markup).toContain("could not list");
    expect(markup).not.toContain("did not answer in time");
  });

  test("no retry button when the caller has no way to ask again", () => {
    // A button that does nothing is worse than no button.
    expect(picker({ incomplete: "timeout" })).not.toContain("Ask git again");
  });

  test("an empty list is a CLAIM about the repository, and only safe when whole", () => {
    // The defect in one assertion: these two states used to render the same.
    expect(picker({ refs: [] })).toContain("This repository has no branches yet");
    const stalled = picker({ refs: [], incomplete: "timeout" });
    expect(stalled).not.toContain("This repository has no branches yet");
    expect(stalled).toContain("did not answer in time");
  });

  test("the refs that did arrive stay pickable under the notice", () => {
    // A misleading list traded for a useless one would be no improvement: what
    // git did answer is still a perfectly good base.
    const markup = picker({ incomplete: "timeout", onRetry: () => {} });
    expect(markup).toContain("origin/main");
  });
});
