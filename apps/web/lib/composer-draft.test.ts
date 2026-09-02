/**
 * What an unsent message survives.
 *
 * Every case here is a paragraph someone typed and did not send. The module's
 * whole reason to exist is that losing one is unacceptable, so the tests are
 * mostly about the ways a slot can be WRONG — a legacy shape, a truncated
 * write, a key from another build — and the answer in every case being "no
 * draft" or "the draft", never a throw.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { listCanvasDrafts, readDraft, writeDraft, type DraftStorage } from "./composer-draft";

function storage(initial: Record<string, string> = {}) {
  const slots = new Map(Object.entries(initial));
  return {
    getItem: (name: string) => slots.get(name) ?? null,
    setItem: (name: string, value: string) => void slots.set(name, value),
    removeItem: (name: string) => void slots.delete(name),
    get length() {
      return slots.size;
    },
    key: (index: number) => [...slots.keys()][index] ?? null,
    slots,
  } satisfies DraftStorage & { slots: Map<string, string> };
}

describe("which slot a composer writes to", () => {
  test("a session keys by session; a canvas keys by project", () => {
    // The canvas key is the one that matters: it is what lets a conversation
    // you started but never sent be found again, by both the composer and the
    // rail, before any session exists to hang it on.
    const store = storage();
    writeDraft("session_7", "project_a", "in a session", store);
    writeDraft(undefined, "project_a", "on the canvas", store);
    expect([...store.slots.keys()].sort()).toEqual(["telar:draft:new:project_a", "telar:draft:session_7"]);
  });

  test("two canvases in different projects do not share a slot", () => {
    const store = storage();
    writeDraft(undefined, "project_a", "for A", store);
    writeDraft(undefined, "project_b", "for B", store);
    expect(readDraft(undefined, "project_a", store)).toBe("for A");
    expect(readDraft(undefined, "project_b", store)).toBe("for B");
  });

  test("the Spool's project-less session still gets its own slot", () => {
    // A session with no project exists before anyone can type into it, so the
    // project half is never reached — but the session half must still key.
    const store = storage();
    writeDraft("master", undefined, "spool thought", store);
    expect([...store.slots.keys()]).toEqual(["telar:draft:master"]);
    expect(readDraft("master", undefined, store)).toBe("spool thought");
  });
});

describe("emptying", () => {
  test("an empty draft removes the key rather than blanking it", () => {
    // Otherwise every session anyone ever opened leaves an entry behind.
    const store = storage();
    writeDraft("session_7", "project_a", "typed", store);
    writeDraft("session_7", "project_a", "", store);
    expect(store.slots.size).toBe(0);
  });

  test("whitespace is empty", () => {
    const store = storage();
    writeDraft("session_7", "project_a", "   \n  ", store);
    expect(store.slots.size).toBe(0);
    expect(readDraft("session_7", "project_a", store)).toBe("");
  });
});

describe("reading a slot another build wrote", () => {
  test("a bare string is still someone's paragraph", () => {
    // The slot used to hold plain text. Drafts in that shape exist in real
    // browsers; dropping them on a format change would break this module's one
    // promise on the commit that claims to take drafts seriously.
    const store = storage({ "telar:draft:new:project_a": "written by the old build" });
    expect(readDraft(undefined, "project_a", store)).toBe("written by the old build");
    expect(listCanvasDrafts(store)).toEqual([
      { projectId: "project_a", text: "written by the old build", updatedAt: 0 },
    ]);
  });

  test("a legacy draft is re-dated by the next keystroke, not lost", () => {
    const store = storage({ "telar:draft:new:project_a": "old" });
    writeDraft(undefined, "project_a", "old and then some", store);
    expect(listCanvasDrafts(store)[0]?.updatedAt).toBeGreaterThan(0);
  });

  test("junk costs the draft, never a throw", () => {
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": "{not json" }))).toBe("");
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": '{"text":7}' }))).toBe("");
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": '{"text":"  "}' }))).toBe("");
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": '{"nope":1}' }))).toBe("");
  });

  test("only a leading brace means JSON; everything else is someone's words", () => {
    // `null` and `[1,2]` are valid JSON and are still, in this slot, a legacy
    // draft that happens to read that way. Guessing otherwise would eat text
    // to satisfy a parser nobody asked for.
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": "null" }))).toBe("null");
    expect(readDraft(undefined, "project_a", storage({ "telar:draft:new:project_a": "[1,2]" }))).toBe("[1,2]");
  });

  test("a slot with text but no age reads, and sorts last", () => {
    const store = storage({ "telar:draft:new:project_a": '{"text":"aged out"}' });
    expect(listCanvasDrafts(store)).toEqual([{ projectId: "project_a", text: "aged out", updatedAt: 0 }]);
  });
});

describe("listing the rail's draft rows", () => {
  test("canvas drafts only — a session's unsent text is not a second row", () => {
    // The session already has a row in the list. Listing its half-written reply
    // beside it would show one conversation twice.
    const store = storage();
    writeDraft(undefined, "project_a", "a started conversation", store);
    writeDraft("session_7", "project_a", "a half-written reply", store);
    expect(listCanvasDrafts(store).map((draft) => draft.projectId)).toEqual(["project_a"]);
  });

  test("newest first — the one you were just writing is on top", () => {
    const store = storage({
      "telar:draft:new:project_a": '{"text":"older","updatedAt":100}',
      "telar:draft:new:project_b": '{"text":"newest","updatedAt":300}',
      "telar:draft:new:project_c": '{"text":"middle","updatedAt":200}',
    });
    expect(listCanvasDrafts(store).map((draft) => draft.text)).toEqual(["newest", "middle", "older"]);
  });

  test("keys from elsewhere in the app are not drafts", () => {
    const store = storage({
      "telar:draft:new:project_a": '{"text":"mine","updatedAt":1}',
      "telar:favorite-models:v2": '["claude-opus-5"]',
      "telar:panel-tabs:session_7": "{}",
      "some-other-app": "hello",
    });
    expect(listCanvasDrafts(store).map((draft) => draft.projectId)).toEqual(["project_a"]);
  });

  test("nothing stored is no drafts, not a failure", () => {
    expect(listCanvasDrafts(storage())).toEqual([]);
  });

  test("sending a first message takes its draft row away", () => {
    // The end of the round trip this whole feature is judged on: what you sent
    // must stop being something you are still writing.
    const store = storage();
    writeDraft(undefined, "project_a", "the first message", store);
    expect(listCanvasDrafts(store)).toHaveLength(1);
    writeDraft(undefined, "project_a", "", store);
    expect(listCanvasDrafts(store)).toEqual([]);
  });
});

describe("a hostile store", () => {
  test("reads and writes fail closed rather than breaking the composer", () => {
    // Safari in private mode throws from setItem once the quota is reached.
    const hostile: DraftStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      length: 1,
      key: () => {
        throw new Error("denied");
      },
    };
    expect(() => writeDraft(undefined, "project_a", "typed", hostile)).not.toThrow();
    expect(readDraft(undefined, "project_a", hostile)).toBe("");
    expect(listCanvasDrafts(hostile)).toEqual([]);
  });
});

describe("the cap", () => {
  test("a runaway paste is truncated, not refused", () => {
    const store = storage();
    writeDraft(undefined, "project_a", "x".repeat(50_000), store);
    expect(readDraft(undefined, "project_a", store)).toHaveLength(20_000);
  });
});
