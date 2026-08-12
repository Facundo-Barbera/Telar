// ISSUE #25 — a compaction now leaves something behind, on both surfaces that
// describe what the model is holding. These are the pure rules that decide WHAT
// it leaves: how one compaction's several events fold into one record, what the
// divider says, and what a reload reconstructs from the store.
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  compactionFacts,
  compactionMarkerText,
  currentCompaction,
  emptyCompactionFold,
  foldCompactionEvent,
  seedCompactedContext,
  seedTranscriptCompactions,
  upsertCompaction,
  type CompactionEventName,
  type CompactionFacts,
  type CompactionRecord,
} from "./compaction";

type Keyed = CompactionFacts & { key: string };

describe("upsertCompaction", () => {
  test("folds the events describing one compaction into one entry", () => {
    // Claude's shape: PostCompact knows the trigger, `compact_boundary` knows
    // the counts, and nothing on the wire carries an id to join them by.
    const opened = upsertCompaction<Keyed>([], { key: "c1", at: 1, trigger: "auto" });
    const closed = upsertCompaction<Keyed>(opened, {
      key: "c1",
      at: 2,
      trigger: "auto",
      preTokens: 152_000,
      postTokens: 41_000,
      durationMs: 4_200,
    });
    expect(opened.length).toBe(1);
    expect(closed.length).toBe(1);
    expect(closed[0]).toEqual({
      key: "c1",
      at: 2,
      trigger: "auto",
      preTokens: 152_000,
      postTokens: 41_000,
      durationMs: 4_200,
    });
  });

  test("a later event never erases what an earlier one supplied", () => {
    // The whole reason the merge is not a plain spread: `compacted` arrives
    // after `compact_boundary` on some orderings, carrying only a trigger.
    const list = upsertCompaction<Keyed>(
      [{ key: "c1", at: 1, trigger: "manual", postTokens: 41_000 }],
      { key: "c1", at: 2, trigger: "manual", postTokens: undefined },
    );
    expect(list[0].postTokens).toBe(41_000);
  });

  test("a distinct key is a distinct compaction", () => {
    const list = upsertCompaction<Keyed>(
      [{ key: "c1", at: 1, trigger: "manual" }],
      { key: "c2", at: 2, trigger: "auto" },
    );
    expect(list.map((c) => c.key)).toEqual(["c1", "c2"]);
  });
});

// The state machine both sides run: which of a stream's events belong to which
// compaction. Every case below is a real wire shape, and the two that used to
// be hand-written inline on each side disagreed about half of them.
describe("foldCompactionEvent", () => {
  const trigger = "auto" as const;
  // The facts a given event actually carries, as each side hands them over.
  const factsFor = (event: CompactionEventName): CompactionFacts =>
    event === "compact_boundary"
      ? { at: 2, trigger, preTokens: 152_000, postTokens: 41_000, durationMs: 4_200 }
      : { at: 1, trigger };
  const run = (...events: CompactionEventName[]) =>
    events.reduce(
      (state, event) => foldCompactionEvent(state, event, factsFor(event)),
      emptyCompactionFold<Keyed>(),
    );

  test("one Claude compaction is one record, in EITHER closing order", () => {
    // The whole hazard: this repo has two comments asserting opposite
    // orderings for PostCompact vs compact_boundary and no trace of either, so
    // both must land on the same answer.
    const forward = run("compacting", "compacted", "compact_boundary");
    const reversed = run("compacting", "compact_boundary", "compacted");
    expect(forward.entries.map((e) => e.key)).toEqual(["c1"]);
    expect(reversed.entries.map((e) => e.key)).toEqual(["c1"]);
    // And the counts survive the event that does not carry them.
    expect(forward.entries[0].postTokens).toBe(41_000);
    expect(reversed.entries[0].postTokens).toBe(41_000);
  });

  test("records nothing while the compaction is still running", () => {
    // "Compacted · automatic" must not appear before it has been.
    expect(run("compacting").entries).toEqual([]);
    expect(run("compacting").open?.key).toBe("c1");
  });

  test("two Codex auto-compactions in one stream are two records", () => {
    // normalizeCodexAutoCompact yields `compact_end` ALONE — no start to mint a
    // fresh key from — so a repeat of an event a compaction has already seen is
    // the only signal that a second one happened.
    expect(run("compacted", "compacted").entries.map((e) => e.key)).toEqual(["c1", "c2"]);
  });

  test("a Codex auto-compaction after an on-demand one is its own record", () => {
    expect(run("compacting", "compacted", "compacted").entries.map((e) => e.key)).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("a new start always opens a new compaction", () => {
    const state = run("compacting", "compacted", "compacting", "compacted");
    expect(state.entries.map((e) => e.key)).toEqual(["c1", "c2"]);
  });

  test("two Claude compactions in one turn stay two records", () => {
    const state = run(
      "compacting",
      "compacted",
      "compact_boundary",
      "compacting",
      "compact_boundary",
      "compacted",
    );
    expect(state.entries.map((e) => e.key)).toEqual(["c1", "c2"]);
    expect(state.entries.every((e) => e.postTokens === 41_000)).toBe(true);
  });

  test("currentCompaction is the MERGE, which is what the wheel reads", () => {
    // The boundary landing first must not leave the wheel reading the
    // count-free "compacted" and reporting that it does not know.
    const state = run("compacting", "compact_boundary", "compacted");
    expect(currentCompaction(state)?.postTokens).toBe(41_000);
    expect(currentCompaction(emptyCompactionFold<Keyed>())).toBeUndefined();
  });

  test("the per-stream key does not follow the record into the store", () => {
    // Keys are minted per stream; persisting one would give the next reader a
    // "c1" that means nothing and collides with the next stream's.
    const entry = run("compacted").entries[0];
    expect(entry.key).toBe("c1");
    expect(compactionFacts(entry)).not.toHaveProperty("key");
    expect(JSON.parse(JSON.stringify(compactionFacts(entry)))).toEqual({ at: 1, trigger });
  });

  test("the route's shape and the client's shape key identically", () => {
    // The claim the whole shared-reducer decision rests on: the route folds the
    // events it sends and the client folds the events it receives, so the two
    // lists agree by construction rather than by inspection.
    const events: CompactionEventName[] = ["compacted", "compacting", "compacted"];
    const client = events.reduce(
      (state, event) =>
        foldCompactionEvent(state, event, { ...factsFor(event), afterMessageId: "m1" }),
      emptyCompactionFold<Keyed & { afterMessageId: string | null }>(),
    );
    expect(client.entries.map((e) => e.key)).toEqual(
      run(...events).entries.map((e) => e.key),
    );
  });
});

describe("compactionMarkerText", () => {
  test("names the trigger, because auto-compaction is otherwise invisible", () => {
    expect(compactionMarkerText({ at: 0, trigger: "auto" })).toBe("Compacted · automatic");
    expect(compactionMarkerText({ at: 0, trigger: "manual" })).toBe("Compacted · manual");
  });

  test("reports the counts and duration when the harness gave them", () => {
    expect(
      compactionMarkerText({
        at: 0,
        trigger: "auto",
        preTokens: 152_000,
        postTokens: 41_000,
        durationMs: 4_200,
      }),
    ).toBe("Compacted · automatic · 152k → 41k · 4.2s");
  });

  test("omits what it was not told rather than printing a zero", () => {
    // Codex reports no counts at all; a bare divider is the honest divider.
    const text = compactionMarkerText({ at: 0, trigger: "manual", durationMs: 0 });
    expect(text).toBe("Compacted · manual");
    expect(text).not.toContain("0");
  });

  test("keeps a count it was given even when the other side is missing", () => {
    // Half a measurement is still a measurement; dropping the pre-count because
    // no post-count arrived would discard information the harness supplied.
    expect(compactionMarkerText({ at: 0, trigger: "auto", postTokens: 41_000 })).toBe(
      "Compacted · automatic · ? → 41k",
    );
    expect(compactionMarkerText({ at: 0, trigger: "manual", preTokens: 152_000 })).toBe(
      "Compacted · manual · 152k → ?",
    );
  });
});

describe("seedTranscriptCompactions", () => {
  const facts = { at: 1, trigger: "manual" as const };

  test("anchors a stored record to the message it followed", () => {
    const seeded = seedTranscriptCompactions(
      [{ ...facts, afterMessages: 2 }],
      ["m1", "m2", "m3"],
    );
    expect(seeded[0].afterMessageId).toBe("m2");
    expect(seeded[0].trigger).toBe("manual");
  });

  test("a compaction above the whole transcript anchors to nothing", () => {
    expect(
      seedTranscriptCompactions([{ ...facts, afterMessages: 0 }], ["m1"])[0].afterMessageId,
    ).toBeNull();
  });

  test("keeps a boundary anchored past the end instead of dropping it", () => {
    expect(
      seedTranscriptCompactions([{ ...facts, afterMessages: 9 }], ["m1", "m2"])[0]
        .afterMessageId,
    ).toBe("m2");
  });

  test("mints one key per record so each yields exactly one divider", () => {
    const seeded = seedTranscriptCompactions(
      [
        { ...facts, afterMessages: 1 },
        { ...facts, afterMessages: 2 },
      ],
      ["m1", "m2"],
    );
    expect(new Set(seeded.map((c) => c.key)).size).toBe(2);
  });

  test("no records is no dividers", () => {
    expect(seedTranscriptCompactions(undefined, ["m1"])).toEqual([]);
  });
});

describe("seedCompactedContext", () => {
  const facts = { at: 1, trigger: "manual" as const };

  test("adopts the harness's post-compaction count when it sits at the bottom", () => {
    // Nothing has re-measured since, so the persisted contextTokens is stale.
    expect(
      seedCompactedContext([{ ...facts, afterMessages: 2, postTokens: 41_000 }], 2),
    ).toBe(41_000);
  });

  test("says unknown rather than guessing when no count was reported", () => {
    expect(seedCompactedContext([{ ...facts, afterMessages: 2 }], 2)).toBe("unknown");
  });

  test("stands down once a turn has happened below the compaction", () => {
    expect(seedCompactedContext([{ ...facts, afterMessages: 2 }], 4)).toBeNull();
  });

  test("stands down for a compaction the SAME turn re-measured below", () => {
    // A mid-turn auto-compaction is stamped once its turn lands, so its anchor
    // is indistinguishable from a compact-only request's — but that turn went
    // on to measure the context again, and the persisted number is both newer
    // and true. Preferring the boundary's count here would install a staleness
    // worse than the one this seed exists to remove, and it would survive every
    // reload.
    expect(
      seedCompactedContext(
        [{ ...facts, afterMessages: 2, postTokens: 41_000, remeasured: true }],
        2,
      ),
    ).toBeNull();
  });

  test("stands down even with nothing to report, rather than saying unknown", () => {
    // Codex reports no counts, so this record would otherwise pin the wheel to
    // "—" for a session whose persisted snapshot is a perfectly good
    // post-compaction measurement.
    expect(
      seedCompactedContext([{ ...facts, afterMessages: 2, remeasured: true }], 2),
    ).toBeNull();
  });

  test("a compact-only request left the persisted number stale, and says so", () => {
    // The other half of the same distinction: no turn landed, so nothing
    // re-measured, so the boundary's own count is the best reading there is.
    expect(
      seedCompactedContext(
        [{ ...facts, afterMessages: 2, postTokens: 41_000, remeasured: false }],
        2,
      ),
    ).toBe(41_000);
  });

  test("an uncompacted session reads its persisted number", () => {
    expect(seedCompactedContext(undefined, 4)).toBeNull();
    expect(seedCompactedContext([], 4)).toBeNull();
  });

  test("only the newest compaction decides", () => {
    const records: CompactionRecord[] = [
      { ...facts, afterMessages: 1, postTokens: 10_000 },
      { ...facts, afterMessages: 4, postTokens: 41_000 },
    ];
    expect(seedCompactedContext(records, 4)).toBe(41_000);
  });
});
