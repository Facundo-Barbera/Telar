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
 * TWO THINGS ARE BEING PROVEN, and the second is the subtle one:
 *
 *   1. A REFUSED write means the only copy of the edit is in the box, and the
 *      box is about to be thrown away. If the stash lost it, or kept it against
 *      the WRONG baseline, re-opening would either show the agent's version as
 *      though you had never typed or write over the agent's version without
 *      being asked. Both are silent.
 *   2. TWO EDITORS OF ONE FILE OVERLAP IN TIME. A write outlives the mount that
 *      started it, so the mount you switched away from is still answering while
 *      the one you re-opened is being typed into. Its answer must not clear the
 *      newer text, and must not overwrite it with the older text. That is what
 *      ownership is for, and `overlapping mounts` below is the test that would
 *      have caught the version of this that did neither.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { SaveCoordinator, type SaveOutcome } from "./save-coordinator";
import {
  claimCellDrafts,
  claimDraft,
  clearDrafts,
  discardDraft,
  draftCount,
  draftScope,
  forgetCellDraft,
  forgetDraft,
  newDraftOwner,
  readDraft,
  rememberCellDraft,
  rememberDraft,
} from "./editor-drafts";

afterEach(() => clearDrafts());

const SCOPE = draftScope(undefined, "session_1");
const OTHER_SESSION = draftScope(undefined, "session_2");
const PATH = "src/a.py";

/**
 * One MOUNT of one file, wired the way the surface wires it: it claims the key
 * as it adopts whatever was left there, every change goes to the stash AND the
 * coordinator, and the coordinator's own callbacks maintain the stash
 * afterwards — because they are what still answers once the component is gone.
 *
 * Two of these can be alive at once, which is the whole point.
 */
function mount(persist: (text: string) => Promise<SaveOutcome>, options: { baseline?: string; disk?: string; scope?: string } = {}) {
  const scope = options.scope ?? SCOPE;
  const owner = newDraftOwner();
  // What `load` does: claim first, then show the stash if there is one.
  const adopted = claimDraft(scope, PATH, owner);
  let current = adopted?.baseline ?? options.baseline ?? "sha-read";
  const shown = adopted?.text ?? options.disk ?? "";
  const latest = { text: shown };
  const reported: string[] = [];
  const saver = new SaveCoordinator({
    debounceMs: 0,
    // No real timers: every write here is driven explicitly, by a flush (⌘S, or
    // the debounce coming due) or by the dispose an unmount causes. What is
    // under test is what happens AFTER a write answers, not when it starts.
    setTimer: () => 0,
    clearTimer: () => undefined,
    persist: async (text) => {
      const outcome = await persist(text);
      if (outcome.status === "saved") current = "sha-after-write";
      return outcome;
    },
    onPending: (value) => reported.push(value ? "saving" : "clean"),
    onSaved: (text) => {
      forgetDraft(scope, PATH, owner);
      if (latest.text !== text) rememberDraft(scope, PATH, { text: latest.text, baseline: current }, owner);
    },
    onProblem: (outcome) => {
      reported.push("problem");
      rememberDraft(
        scope,
        PATH,
        { text: latest.text, baseline: current, problem: { refused: outcome.status === "refused", reason: outcome.reason } },
        owner,
      );
    },
  });
  return {
    shown,
    reported,
    type(text: string) {
      latest.text = text;
      rememberDraft(scope, PATH, { text, baseline: current }, owner);
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
function reopen(disk: { text: string; sha256: string }, scope = SCOPE) {
  const stashed = readDraft(scope, PATH);
  return { text: stashed?.text ?? disk.text, baseline: stashed?.baseline ?? disk.sha256, problem: stashed?.problem };
}

/** A promise you settle by hand, for a write that is still in the air. */
function deferred() {
  let settle: ((outcome: SaveOutcome) => void) | undefined;
  const persist = () => new Promise<SaveOutcome>((resolve) => (settle = resolve));
  return { persist, settle: (outcome: SaveOutcome) => settle!(outcome) };
}

describe("a refused save survives switching files", () => {
  test("A → B → A gives back the text, not the disk", async () => {
    // The blocker this closes: the draft used to live only in the unmounted
    // component, so coming back read disk and reported clean — the edit was
    // gone with no trace but a dot that had also gone.
    const file = mount(async () => ({ status: "refused", reason: "conflict" }));
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
    const file = mount(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();
    expect(reopen({ text: "written by the agent", sha256: "sha-agent" }).baseline).toBe("sha-read");
  });

  test("re-reading from disk is the way to discard it, and it really discards", async () => {
    const file = mount(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();
    // What the conflict banner's button and the refresh button both do.
    discardDraft(SCOPE, PATH);
    expect(reopen({ text: "written by the agent", sha256: "sha-agent" })).toMatchObject({ text: "written by the agent", baseline: "sha-agent" });
  });

  test("a deliberate discard works even though the mount that owned it is gone", () => {
    // Ownership guards LATE ANSWERS, not the person pressing the button: the
    // Editor closing a refused tab is not the mount that claimed the key, and
    // an owner-guarded delete there would quietly fail and bring the text back
    // the next time the file was opened.
    rememberDraft(SCOPE, PATH, { text: "unsaved", baseline: "sha" }, newDraftOwner());
    discardDraft(SCOPE, PATH);
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });
});

describe("overlapping mounts of the same file", () => {
  test("an old mount's REFUSAL cannot overwrite what the new one is holding", async () => {
    /**
     * The race, exactly: type in mount one, switch away with the write in the
     * air, come back — mount two adopts the text — type something newer, and
     * only then let mount one's write fail. Without ownership, mount one's
     * `onProblem` writes ITS `latest` (the older text) over the newer draft,
     * and the newer edit is gone with nothing on screen to say so.
     */
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "refused", reason: "conflict" }), { disk: "on disk" });
    expect(fresh.shown).toBe("older text"); // adopted, and claimed
    fresh.type("newer text");

    first.settle({ status: "refused", reason: "conflict" });
    await flight;

    expect(readDraft(SCOPE, PATH)?.text).toBe("newer text");
  });

  test("an old mount's SUCCESS cannot clear what the new one is holding", async () => {
    // The other half: `onSaved` calls forgetDraft, which would delete the newer
    // mount's stash outright — and then re-insert the OLD text, because the old
    // mount's own `latest` still differs from what it saved.
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "refused", reason: "conflict" }));
    fresh.type("newer text");

    first.settle({ status: "saved" });
    await flight;

    expect(readDraft(SCOPE, PATH)?.text).toBe("newer text");
    expect(draftCount()).toBe(1);
  });

  test("an old mount's transport FAILURE cannot overwrite it either", async () => {
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "refused", reason: "conflict" }));
    fresh.type("newer text");

    first.settle({ status: "failed", reason: "The save could not be sent." });
    await flight;

    expect(readDraft(SCOPE, PATH)).toMatchObject({ text: "newer text" });
  });

  test("the NEW mount still owns the key afterwards, so its own writes still land", async () => {
    // Ownership must transfer, not merely block: if the newer mount could not
    // write either, the file would freeze in whatever state the race left.
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "saved" }));
    fresh.type("newer text");
    first.settle({ status: "refused", reason: "conflict" });
    await flight;

    await fresh.flush();
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });
});

describe("a write still open when the file goes away", () => {
  test("a delayed SUCCESS after the unmount clears the stash", async () => {
    // The ordinary case, and it must not leave an edit behind to be resurrected
    // the next time the file is opened.
    const write = deferred();
    const file = mount(write.persist);
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    // The write is in the air, and the text is recoverable while it is.
    expect(readDraft(SCOPE, PATH)?.text).toBe("typed then switched away");
    write.settle({ status: "saved" });
    await flush;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
    expect(draftCount()).toBe(0);
  });

  test("a delayed REFUSAL after the unmount keeps it, with the reason", async () => {
    const write = deferred();
    const file = mount(write.persist);
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    write.settle({ status: "refused", reason: "conflict" });
    await flush;
    expect(reopen({ text: "disk", sha256: "sha-agent" })).toMatchObject({ text: "typed then switched away", problem: { refused: true, reason: "conflict" } });
  });

  test("a transport FAILURE after the unmount keeps it too", async () => {
    // `failed` is not `refused` — the coordinator will try again — but until it
    // does, the only copy is still the stash.
    const write = deferred();
    const file = mount(write.persist);
    file.type("typed then switched away");
    const flush = file.flush();
    file.unmount();
    write.settle({ status: "failed", reason: "The save could not be sent." });
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
    const write = deferred();
    const file = mount(write.persist);
    file.type("first");
    const flush = file.flush();
    file.type("first and second");
    write.settle({ status: "saved" });
    await flush;
    expect(readDraft(SCOPE, PATH)?.text).toBe("first and second");
  });
});

describe("nothing crosses a checkout — or a Mac", () => {
  test("the same path in two sessions is two drafts", () => {
    // A worktree per session is the normal case here, so a scope-less key would
    // hand one session's unsaved text to another session's editor.
    const one = newDraftOwner();
    const two = newDraftOwner();
    rememberDraft(SCOPE, PATH, { text: "session one", baseline: "a" }, one);
    rememberDraft(OTHER_SESSION, PATH, { text: "session two", baseline: "b" }, two);
    expect(readDraft(SCOPE, PATH)?.text).toBe("session one");
    expect(readDraft(OTHER_SESSION, PATH)?.text).toBe("session two");
    forgetDraft(SCOPE, PATH, one);
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
    expect(readDraft(OTHER_SESSION, PATH)?.text).toBe("session two");
  });

  test("the SAME session id on two Macs is two drafts", () => {
    /**
     * Session ids are minted per engine, so two hosts can mint the same one —
     * and this store is one global Map for the whole page. Without the host in
     * the key, opening `src/a.py` of session_1 on the second Mac would hand you
     * the first Mac's unsaved text, and typing would then write it there.
     */
    const here = draftScope(undefined, "session_1");
    const there = draftScope("mac-studio", "session_1");
    expect(here).not.toBe(there);
    const mine = newDraftOwner();
    const theirs = newDraftOwner();
    rememberDraft(here, PATH, { text: "typed on this Mac", baseline: "a" }, mine);
    rememberDraft(there, PATH, { text: "typed on the other Mac", baseline: "b" }, theirs);
    expect(readDraft(here, PATH)?.text).toBe("typed on this Mac");
    expect(readDraft(there, PATH)?.text).toBe("typed on the other Mac");
    // And an explicit local host id is the same scope as no host id at all,
    // so a screen that names "local" and one that does not agree.
    expect(draftScope("local", "session_1")).toBe(here);
  });

  test("a project canvas and a session are different scopes", () => {
    expect(draftScope(undefined, "session_1")).not.toBe(draftScope(undefined, undefined, "project_1"));
    // And a session id wins when both are present — a session has its own
    // checkout the moment it cuts a worktree.
    expect(draftScope(undefined, "session_1", "project_1")).toBe(draftScope(undefined, "session_1"));
  });
});

describe("notebook cells", () => {
  const NOTEBOOK = "analysis.ipynb";

  test("a cell whose write FAILS is still there when the notebook is re-opened", async () => {
    /**
     * Flushing the debounce on unmount only saves the cells whose write
     * succeeds. The one that fails — engine unreachable, notebook rewritten
     * under it — used to have nowhere to leave its text but a component that
     * was already being thrown away.
     */
    const first = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_2", "x = 41  # nearly", first);
    // The flush fails, so nothing forgets it.
    const second = newDraftOwner();
    expect([...claimCellDrafts(SCOPE, NOTEBOOK, second)]).toEqual([["cell_2", "x = 41  # nearly"]]);
  });

  test("a cell whose write LANDS is forgotten, and only that cell", () => {
    const owner = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "saved", owner);
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_2", "still owed", owner);
    forgetCellDraft(SCOPE, NOTEBOOK, "cell_1", owner);
    expect([...claimCellDrafts(SCOPE, NOTEBOOK, newDraftOwner())]).toEqual([["cell_2", "still owed"]]);
  });

  test("an old mount's late answer cannot clear or overwrite a re-opened cell", () => {
    // The same race as a file's, one level down: the notebook you switched away
    // from is still waiting on `notebookEdit`.
    const old = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "older", old);
    const fresh = newDraftOwner();
    claimCellDrafts(SCOPE, NOTEBOOK, fresh);
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "newer", fresh);
    // Now the old mount's write answers — either way.
    expect(forgetCellDraft(SCOPE, NOTEBOOK, "cell_1", old)).toBe(false);
    expect(rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "older", old)).toBe(false);
    expect([...claimCellDrafts(SCOPE, NOTEBOOK, fresh)]).toEqual([["cell_1", "newer"]]);
  });

  test("cells of two notebooks, and of two Macs, do not mix", () => {
    const owner = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "here", owner);
    rememberCellDraft(SCOPE, "other.ipynb", "cell_1", "elsewhere", owner);
    rememberCellDraft(draftScope("mac-studio", "session_1"), NOTEBOOK, "cell_1", "another Mac", owner);
    expect([...claimCellDrafts(SCOPE, NOTEBOOK, owner)]).toEqual([["cell_1", "here"]]);
  });
});

describe("a save that lands leaves nothing behind", () => {
  test("the ordinary path stashes while typing and clears when it is written", async () => {
    const file = mount(async () => ({ status: "saved" }));
    file.type("hello");
    expect(readDraft(SCOPE, PATH)?.text).toBe("hello");
    await file.flush();
    expect(draftCount()).toBe(0);
    expect(file.reported).toContain("saving");
    expect(file.reported).toContain("clean");
  });
});
