/**
 * The shelf the composer draws — two stores, one list.
 *
 * What is under test is the set of decisions #87 forced on the MERGE, rather
 * than the mapping:
 *   · an agent's band is FIRST and WHOLE, never interleaved by timestamp,
 *     because an undifferentiated list is what the issue says must not happen;
 *   · a composer is offered the project's prompts and its OWN session's, and
 *     nobody else's follow-up;
 *   · a ⌘S entry is always the person's, and an engine row the person wrote
 *     sits with theirs rather than in the agent band;
 *   · the two stores mint ids independently, so the keys must not collide.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { PreparedPrompt } from "@telar/engine-client";
import type { StashEntry } from "./prompt-stash";
import { engineRows, mergeShelf, stashRows } from "./prompt-shelf";

const stamp = (at: number) => ({ label: "Thu 10:00", at });

const prompt = (extra: Partial<PreparedPrompt> = {}): PreparedPrompt =>
  ({
    id: "q-1",
    projectId: "p1",
    title: "Ship it",
    text: "run the release",
    created: stamp(1),
    updated: stamp(1),
    author: "session",
    schemaVersion: 1,
    ...extra,
  }) as PreparedPrompt;

const entry = (extra: Partial<StashEntry> = {}): StashEntry => ({
  id: "s-1",
  at: 1,
  prompt: "my own half-thought",
  images: [],
  ...extra,
});

describe("the bands", () => {
  test("an agent's drafts come first and whole — never interleaved by time", () => {
    const merged = mergeShelf(
      [entry({ id: "s-new", at: 500 })],
      [prompt({ id: "q-old", title: "Older draft", created: stamp(1) })],
      undefined,
    );

    // The stash row is NEWER and still sits second: authority bands the list,
    // not the clock. A newest-first merge would put a proposal you have not
    // read under a heading that says it is yours.
    expect(merged.rows.map((row) => row.key)).toEqual(["engine:q-old", "stash:s-new"]);
    expect(merged.agents.map((row) => row.key)).toEqual(["engine:q-old"]);
    expect(merged.yours.map((row) => row.key)).toEqual(["stash:s-new"]);
  });

  test("within a band it is newest first", () => {
    const merged = mergeShelf(
      [entry({ id: "s-old", at: 1 }), entry({ id: "s-new", at: 9 })],
      [prompt({ id: "q-old", created: stamp(1) }), prompt({ id: "q-new", created: stamp(9) })],
      undefined,
    );
    expect(merged.agents.map((row) => row.id)).toEqual(["q-new", "q-old"]);
    expect(merged.yours.map((row) => row.id)).toEqual(["s-new", "s-old"]);
  });

  test("an engine row the PERSON wrote sits with their stash, not in the agent band", () => {
    // Same hand, different store. This arm is what the open migration question
    // would eventually fill, and banding on `author` is what makes it a no-op.
    const merged = mergeShelf([entry({ at: 1 })], [prompt({ id: "q-mine", author: "you", created: stamp(5) })], undefined);
    expect(merged.agents).toEqual([]);
    expect(merged.yours.map((row) => row.id)).toEqual(["q-mine", "s-1"]);
  });

  test("a ⌘S entry is always the person's, whatever else is on the shelf", () => {
    expect(stashRows([entry()]).every((row) => row.author === "you")).toBe(true);
  });
});

describe("whose composer a prompt belongs to", () => {
  test("this session's and the project's, and nobody else's", () => {
    const prompts = [
      prompt({ id: "q-anyone" }),
      prompt({ id: "q-mine", sessionId: "s1" }),
      prompt({ id: "q-theirs", sessionId: "s2" }),
    ];
    expect(engineRows(prompts, "s1").map((row) => row.id).sort()).toEqual(["q-anyone", "q-mine"]);
    // A fresh canvas has no session of its own and still sees the project's,
    // which is the generation case's whole point.
    expect(engineRows(prompts, undefined).map((row) => row.id)).toEqual(["q-anyone"]);
  });
});

describe("the rows themselves", () => {
  test("a stash entry with no text is named by what it does have", () => {
    const row = stashRows([entry({ prompt: "", images: [{ name: "a.png", type: "image/png", dataUrl: "data:," }] })])[0]!;
    expect(row.title).toBe("1 image");
  });

  test("an agent's reason rides along; a stash row has none to show", () => {
    expect(engineRows([prompt({ reason: "the tests pass now" })], undefined)[0]!.reason).toBe("the tests pass now");
    expect(stashRows([entry()])[0]!.reason).toBeUndefined();
  });

  test("the two stores' ids cannot collide in a React key", () => {
    // Both mint their own ids and nothing coordinates them; one shared key
    // would swap two rows' identities on the next re-sort.
    const merged = mergeShelf([entry({ id: "same" })], [prompt({ id: "same", author: "you" })], undefined);
    expect(new Set(merged.rows.map((row) => row.key)).size).toBe(2);
  });

  test("an empty shelf is an empty list, not a thrown read", () => {
    expect(mergeShelf([], [], "s1")).toEqual({ agents: [], yours: [], rows: [], count: 0 });
  });
});
