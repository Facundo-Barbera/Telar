/**
 * Drives `SaveCoordinator` and the draft stash the way file-view-surface.tsx does, with no DOM,
 * and asserts what a re-mount would find. Two mounts of one file can overlap in time; an old
 * mount's late answer must neither clear nor overwrite the newer mount's text.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { SaveCoordinator, type SaveOutcome } from "./save-coordinator";
import {
  claimCellDraft,
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
 * One mount of one file, wired as the surface wires it. The coordinator's callbacks maintain
 * the stash because they still answer after the component is gone.
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
    // No real timers: every write is driven explicitly by a flush or an unmount's dispose.
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
    const file = mount(async () => ({ status: "refused", reason: "conflict" }));
    file.type("edited by me");
    await file.flush();
    file.unmount();

    const back = reopen({ text: "written by the agent", sha256: "sha-agent" });
    expect(back.text).toBe("edited by me");
    expect(back.problem).toEqual({ refused: true, reason: "conflict" });
  });

  test("…against the baseline it was EDITED from, so the second write is refused too", async () => {
    // Writing against the fresh read's hash would silently overwrite whatever moved the file.
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
    // Ownership guards late answers, not explicit discards from a different mount.
    rememberDraft(SCOPE, PATH, { text: "unsaved", baseline: "sha" }, newDraftOwner());
    discardDraft(SCOPE, PATH);
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });
});

describe("overlapping mounts of the same file", () => {
  test("an old mount's REFUSAL cannot overwrite what the new one is holding", async () => {
    /** Mount one's write fails only after mount two has adopted and changed the text. */
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
    // `onSaved` would otherwise delete the newer stash and re-insert the older text.
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
    // Ownership must transfer, not merely block.
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

describe("an old mount answering after the key has been EMPTIED", () => {
  /** Ownership is kept beside the key rather than on the value, so an emptied key still has an owner. */
  test("a delayed SUCCESS cannot resurrect its text after the newer mount saved", async () => {
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "saved" }));
    fresh.type("newer text");
    await fresh.flush();
    expect(readDraft(SCOPE, PATH)).toBeUndefined();

    first.settle({ status: "saved" });
    await flight;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
    expect(draftCount()).toBe(0);
  });

  test("a delayed REFUSAL cannot resurrect its text after the newer mount saved", async () => {
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "saved" }));
    fresh.type("newer text");
    await fresh.flush();

    first.settle({ status: "refused", reason: "conflict" });
    await flight;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });

  test("a delayed transport FAILURE cannot either", async () => {
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "saved" }));
    fresh.type("newer text");
    await fresh.flush();

    first.settle({ status: "failed", reason: "The save could not be sent." });
    await flight;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });

  test("a delayed answer cannot undo an explicit DISCARD", async () => {
    // A write still in the air must not undo a deliberate discard.
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    discardDraft(SCOPE, PATH);

    first.settle({ status: "refused", reason: "conflict" });
    await flight;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });

  test("…and the key is still writable by whoever claims it next", async () => {
    // After a discard, the next mount to claim the key saves normally.
    discardDraft(SCOPE, PATH);
    const fresh = mount(async () => ({ status: "refused", reason: "conflict" }));
    fresh.type("typed after the discard");
    await fresh.flush();
    expect(readDraft(SCOPE, PATH)?.text).toBe("typed after the discard");
  });
});

describe("ownership does not expire", () => {
  /**
   * An evicting ownership map is unsound both ways: an evicted key accepts a stale writer,
   * and refusing unclaimed keys would lock out a live mount.
   */
  const CLAIMS = 600;

  test("a stale answer is still refused after hundreds of unrelated claims", async () => {
    const first = deferred();
    const old = mount(first.persist);
    old.type("older text");
    const flight = old.flush();
    old.unmount();

    const fresh = mount(async () => ({ status: "saved" }));
    fresh.type("newer text");
    await fresh.flush(); // the key is now empty, and B's

    // Enough traffic that an eviction policy would have forgotten this key.
    for (let index = 0; index < CLAIMS; index += 1) {
      claimDraft(SCOPE, `noise/file-${index}.ts`, newDraftOwner());
      claimCellDraft(SCOPE, "noise.ipynb", `cell_${index}`, newDraftOwner());
    }

    first.settle({ status: "refused", reason: "conflict" });
    await flight;
    expect(readDraft(SCOPE, PATH)).toBeUndefined();
  });

  test("a LIVE owner can still write after hundreds of unrelated claims", () => {
    // The mount whose ownership would be evicted is the one being typed in.
    const live = newDraftOwner();
    claimDraft(SCOPE, PATH, live);
    claimCellDraft(SCOPE, "live.ipynb", "cell_1", live);

    for (let index = 0; index < CLAIMS; index += 1) {
      claimDraft(SCOPE, `noise/file-${index}.ts`, newDraftOwner());
      claimCellDraft(SCOPE, "noise.ipynb", `cell_${index}`, newDraftOwner());
    }

    expect(rememberDraft(SCOPE, PATH, { text: "typed much later", baseline: "sha" }, live)).toBe(true);
    expect(readDraft(SCOPE, PATH)?.text).toBe("typed much later");
    expect(rememberCellDraft(SCOPE, "live.ipynb", "cell_1", "typed much later", live)).toBe(true);
  });
});

describe("a write still open when the file goes away", () => {
  test("a delayed SUCCESS after the unmount clears the stash", async () => {
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
    // `failed` will be retried, but until then the only copy is the stash.
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
    // The coordinator reports the text it saved, which is not the newest text.
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
    // Worktrees are per session, so a scope-less key would leak drafts between sessions.
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
    /** Session ids are minted per engine and this store is one global Map, so the host is in the key. */
    const here = draftScope(undefined, "session_1");
    const there = draftScope("mac-studio", "session_1");
    expect(here).not.toBe(there);
    const mine = newDraftOwner();
    const theirs = newDraftOwner();
    rememberDraft(here, PATH, { text: "typed on this Mac", baseline: "a" }, mine);
    rememberDraft(there, PATH, { text: "typed on the other Mac", baseline: "b" }, theirs);
    expect(readDraft(here, PATH)?.text).toBe("typed on this Mac");
    expect(readDraft(there, PATH)?.text).toBe("typed on the other Mac");
    // An explicit "local" host id is the same scope as none.
    expect(draftScope("local", "session_1")).toBe(here);
  });

  test("a project canvas and a session are different scopes", () => {
    expect(draftScope(undefined, "session_1")).not.toBe(draftScope(undefined, undefined, "project_1"));
    // A session id wins when both are present.
    expect(draftScope(undefined, "session_1", "project_1")).toBe(draftScope(undefined, "session_1"));
  });
});

describe("notebook cells", () => {
  const NOTEBOOK = "analysis.ipynb";

  test("a cell whose write FAILS is still there when the notebook is re-opened", async () => {
    /** Flushing on unmount saves only the cells whose write succeeds; a failed one must stay stashed. */
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
    // The same race as a file's, one level down.
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

  test("an old mount's late answer cannot resurrect a cell the newer mount SAVED", () => {
    // The emptied-key window, one level down.
    const old = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "older", old);
    const fresh = newDraftOwner();
    claimCellDrafts(SCOPE, NOTEBOOK, fresh);
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "newer", fresh);
    // The newer write lands: the cell is clean, and the key is empty.
    forgetCellDraft(SCOPE, NOTEBOOK, "cell_1", fresh);
    // Now the old mount answers — either way.
    expect(rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "older", old)).toBe(false);
    expect([...claimCellDrafts(SCOPE, NOTEBOOK, newDraftOwner())]).toEqual([]);
  });

  test("a live mount can type into a cell an earlier mount still owns", () => {
    // Ownership outlives the text, so typing into a cell the previous mount saved must claim it first.
    const old = newDraftOwner();
    rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "saved by the last mount", old);
    forgetCellDraft(SCOPE, NOTEBOOK, "cell_1", old);
    const fresh = newDraftOwner();
    claimCellDrafts(SCOPE, NOTEBOOK, fresh); // nothing to adopt: the key is empty
    claimCellDraft(SCOPE, NOTEBOOK, "cell_1", fresh);
    expect(rememberCellDraft(SCOPE, NOTEBOOK, "cell_1", "typed now", fresh)).toBe(true);
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
