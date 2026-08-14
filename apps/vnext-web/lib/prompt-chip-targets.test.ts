/**
 * WHICH CHIPS IN A SENT MESSAGE OPEN SOMETHING.
 *
 * The mapping lives beside the chip that renders it (`panelTabFor` in
 * components/session/prompt-text.tsx); this pins the half of it that is a
 * DECISION rather than a lookup — that three kinds open and three do not, and
 * which of the two a given reference is. Getting that wrong in either direction
 * is a visible defect: a chip that looks pressable and is not, or one that opens
 * something adjacent to what you pressed.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { panelTabFor } from "@/components/session/prompt-text";
import { checkReference, directoryReference, fileReference, issueReference, pageReference, pullReference, taskReference } from "./drag-reference";

describe("panelTabFor", () => {
  test("an issue and a pull request open their own tab, by number", () => {
    expect(panelTabFor(issueReference({ number: 409, title: "Identidad", url: "https://github.com/o/r/issues/409" }))).toBe("issue:409");
    expect(panelTabFor(pullReference({ number: 82, title: "Fix it", url: "https://github.com/o/r/pull/82" }))).toBe("pull:82");
  });

  test("a pull request is not read as the issue its text contains", () => {
    // `PR #82 "…" (…)` contains `#82 "…" (…)`. The parse anchors to the start of
    // the reference for exactly this reason.
    const pull = pullReference({ number: 82, title: "Fix it", url: "https://github.com/o/r/pull/82" });
    expect(panelTabFor(pull)).not.toBe("issue:82");
  });

  test("a file opens its viewer, at the path the chip stands for", () => {
    expect(panelTabFor(fileReference("apps/engine/src/state.ts"))).toBe("file:apps/engine/src/state.ts");
  });

  test("a DIRECTORY opens nothing", () => {
    // The file surface reads a file. Pointing it at a directory would either
    // fail or land you somewhere adjacent, and adjacent is worse than nothing —
    // you have to work out where you ended up.
    expect(panelTabFor(directoryReference("apps/engine"))).toBeUndefined();
  });

  test("the three kinds with nothing to address open nothing", () => {
    // A page carries a URL, and the browser surface addresses tabs by the
    // ENGINE's id. A task names a sub-agent the Agents panel addresses by id. A
    // check belongs to a pull request's own view. None of the three references
    // carries the handle its surface needs.
    expect(panelTabFor(pageReference({ title: "Docs", url: "https://example.com/docs" }))).toBeUndefined();
    expect(panelTabFor(taskReference({ id: "task_a", title: "Audit the parser", state: "running" }))).toBeUndefined();
    expect(panelTabFor(checkReference({ name: "build", status: "completed", conclusion: "failure" }))).toBeUndefined();
  });
});
