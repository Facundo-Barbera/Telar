/**
 * UNSAVED TEXT ACROSS AN UNMOUNT — the protocol, not the component.
 *
 * The Editor mounts only the file you are looking at, so switching files
 * unmounts the editor holding the text. Everything that keeps that text
 * recoverable lives in two places: `SaveCoordinator`, which flushes rather than
 * cancels, and this stash, which holds what the coordinator could NOT write.
 * There is no DOM in this test suite, so these tests drive the same pair the
 * component drives — a coordinator built exactly as file-view-surface.tsx
 * builds one, against a persist that answers the way the engine does — and
 * assert on what a re-mount would find.
 *
 * THE ONE THAT MATTERS: a refused write means the only copy of the edit is in
 * the box, and the box is about to be thrown away. If the stash lost it, or
 * kept it against the WRONG baseline, re-opening the file would either show the
 * agent's version as though you had never typed or write over the agent's
 * version without being asked. Both are silent.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { SaveCoordinator, type SaveOutcome } from "./save-coordinator";
import { clearDrafts, draftCount, draftScope, forgetDraft, readDraft, rememberDraft } from "./editor-drafts";

afterEach(() => clearDrafts());

const SCOPE = draftScope("session_1");
const OTHER = draftScope("session_2");
const PATH = "src/a.py";

/**
 * One open file, wired the way the surface wires it: every change goes to the
 * stash AND the coordinator; the coordinator's own callbacks maintain the stash
 * afterwards, because they are what still answers once the component is gone.
 */
function openFile(persist: (text: string) => Promise<SaveOutcome>, baseline = "sha-read") {
  let current = baseline;
  const reported: string[] = [];
  const latest = { text: "" };
  const saver = new SaveCoordinator({
    debounceMs: 0,
    // No real timers: every write in these tests is driven explicitly, by a
    // flush (⌘S, or the debounce coming due) or by the dispose an unmount
    // causes. What is under test is what happens AFTER a write answers, not
    // when it starts.
    setTimer: () => 0,
    clearTimer: () => undefined,
    persist: async (text) => {
      const outcome = await persist(text);
      if (outcome.status === "saved") current = "sha-after-write";
      return outcome;
    },
    onPending: (value) => reported.push(value ? "saving" : "clean"),
    onSaved: (text) => {
      forgetDraft(SCOPE, PATH);
      if (latest.text !== text) rememberDraft(SCOPE, PATH, { text: latest.text, baseline: current });
    },
    onProblem: (outcome) => {
      reported.push("problem");
      rememberDraft(SCOPE, PATH, {
        text: latest.text,
        baseline: current,
        problem: { refused: outcome.status === "refused", reason: outcome.reason },
      });
    },
  });
  return {
    reported,
    type(text: string) {
      latest.text = text;
      rememberDraft(SCOPE, PATH, { text, baseline: current });
      saver.change(text);
    },
    /** What switching to another file does: the coordinator flushes. */
    unmount() {
      saver.dispose();
    },
    flush: () => saver.flush(),
  };
}

/** What a re-mount would put in the box: the stash if there is one, else disk. */
function reopen(disk: { text: string; sha256: string }) {
  const stashed = readDraft(SCOPE, PATH);
  return { text: stashed?.text ?? disk.text, baseline: stashed?.baseline ?? disk.sha256, problem: stashed?.problem };
}

describe("a refused save survives switching files", () => {
  test("A → B → A gives back the text, not the disk", async () => {
    // The blocker this closes: the draft used to live only in the unmounted
    // component, so coming back read disk and reported clean — the edit was
    // gone with no trace but a dot that had also gone.
    const file = openFile(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();

    const back = reopen({ text: "written by the agent", sha256: "sha-agent" });
    expect(back.text).toBe("edited by me");
    expect(back.problem).toEqual({ refused: true, reason: "conflict" });
  });

  test("…against the baseline it was EDITED from, so the second write is refused too", async () => {
    // The dangerous direction. Adopting the text but writing against the fresh
    // read's hash would make the engine accept it, silently destroying whatever
    // moved the file — a refusal turned into a win.
    const file = openFile(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();
    expect(reopen({ text: "written by the agent", sha256: "sha-agent" }).baseline).toBe("sha-read");
  });

  test("re-reading from disk is the way to discard it, and it really discards", async () => {
    const file = openFile(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();
    // What the conflict banner's button and the refresh button both do.
    forgetDraft(SCOPE, PATH);
    expect(reopen({ text: "written by the agent", sha256: "sha-agent" })).toMatchObject({ text: "written by the agent", baseline: "sha-agent" });
  });
});

describe("a write still open when the file goes away", () => {
  test("a delayed SUCCESS after the unmount clears the stash", async () => {
    // The ordinary case, and it must not leave an edit behind to be resurrected
    // the next time the file is opened.
    let settle: ((outcome: SaveOutcome) => void) | undefined;
    const file = openFile(() => new Promise<SaveOutcome>((resolve) => (settle = resolve)));
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    // The write is in the air, and the text is recoverable while it is.
    expect(readDraft(SCOPE, PATH)?.text).toBe("typed then switched away");
    settle!({ status: "saved" });
    await flush;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
    expect(draftCount()).toBe(0);
  });

  test("a delayed REFUSAL after the unmount keeps it, with the reason", async () => {
    let settle: ((outcome: SaveOutcome) => void) | undefined;
    const file = openFile(() => new Promise<SaveOutcome>((resolve) => (settle = resolve)));
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    settle!({ status: "refused", reason: "conflict" });
    await flush;
    expect(reopen({ text: "disk", sha256: "sha-agent" })).toMatchObject({ text: "typed then switched away", problem: { refused: true, reason: "conflict" } });
  });

  test("a transport FAILURE after the unmount keeps it too", async () => {
    // `failed` is not `refused` — the coordinator will try again — but until it
    // does, the only copy is still the stash.
    let settle: ((outcome: SaveOutcome) => void) | undefined;
    const file = openFile(() => new Promise<SaveOutcome>((resolve) => (settle = resolve)));
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    settle!({ status: "failed", reason: "The save could not be sent." });
    await flush;
    expect(reopen({ text: "disk", sha256: "sha-agent" })).toMatchObject({
      text: "typed then switched away",
      problem: { refused: false, reason: "The save could not be sent." },
    });
  });

  test("text typed WHILE a write was open outlives that write landing", async () => {
    // The coordinator reports the text it SAVED, which is not the newest text.
    // Clearing the stash on that report alone would drop the characters typed
    // during the round trip.
    let settle: ((outcome: SaveOutcome) => void) | undefined;
    const file = openFile(() => new Promise<SaveOutcome>((resolve) => (settle = resolve)));
    file.type("first");
    const flush = file.flush();
    file.type("first and second");
    settle!({ status: "saved" });
    await flush;
    expect(readDraft(SCOPE, PATH)?.text).toBe("first and second");
  });
});

describe("nothing crosses a checkout", () => {
  test("the same path in two sessions is two drafts", () => {
    // A worktree per session is the normal case here, so a scope-less key would
    // hand one session's unsaved text to another session's editor.
    rememberDraft(SCOPE, PATH, { text: "session one", baseline: "a" });
    rememberDraft(OTHER, PATH, { text: "session two", baseline: "b" });
    expect(readDraft(SCOPE, PATH)?.text).toBe("session one");
    expect(readDraft(OTHER, PATH)?.text).toBe("session two");
    forgetDraft(SCOPE, PATH);
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
    expect(readDraft(OTHER, PATH)?.text).toBe("session two");
  });

  test("a project canvas and a session are different scopes", () => {
    expect(draftScope("session_1")).not.toBe(draftScope(undefined, "project_1"));
    // And a session id wins when both are present — a session has its own
    // checkout the moment it cuts a worktree.
    expect(draftScope("session_1", "project_1")).toBe(draftScope("session_1"));
  });
});

describe("a save that lands leaves nothing behind", () => {
  test("the ordinary path stashes while typing and clears when it is written", async () => {
    const file = openFile(async () => ({ status: "saved" }));
    file.type("hello");
    expect(readDraft(SCOPE, PATH)?.text).toBe("hello");
    await file.flush();
    expect(draftCount()).toBe(0);
    expect(file.reported).toContain("saving");
    expect(file.reported).toContain("clean");
  });
});
