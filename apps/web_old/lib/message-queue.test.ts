// The queue's persistence policy. What is worth proving here is not the JSON
// round-trip — it is the ORDER OF SACRIFICE when the queue does not fit, because
// that order is the difference between losing a screenshot and losing what the
// user wrote.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  MAX_QUEUE_BYTES,
  fitToBudget,
  queueStorageKey,
  readQueue,
  writeQueue,
} from "./message-queue";

type Msg = { id: string; text: string; files?: { url: string }[] };

const strip = (m: Msg): Msg => ({ id: m.id, text: m.text });
const msg = (id: string, text: string, attachmentBytes = 0): Msg => ({
  id,
  text,
  ...(attachmentBytes > 0 ? { files: [{ url: "x".repeat(attachmentBytes) }] } : {}),
});

/** A Storage double. `failAfter` makes setItem throw like a real quota error. */
function fakeStorage(options: { failSetItem?: boolean } = {}): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      if (options.failSetItem) throw new DOMException("QuotaExceededError");
      map.set(k, v);
    },
  } as Storage & { map: Map<string, string> };
}

describe("queueStorageKey — namespaced per session", () => {
  test("keys are per-session and carry the telar prefix", () => {
    expect(queueStorageKey("abc")).toBe("telar:queue:abc");
    expect(queueStorageKey("a")).not.toBe(queueStorageKey("b"));
  });
});

describe("fitToBudget — attachments are sacrificed before text", () => {
  test("a queue that fits is returned untouched", () => {
    const items = [msg("q0", "hello"), msg("q1", "world")];
    const fit = fitToBudget(items, strip);
    expect(fit.items).toEqual(items);
    expect(fit.shedAttachments).toBe(false);
    expect(fit.droppedCount).toBe(0);
  });

  test("an oversized attachment is shed and every word survives", () => {
    // THE CENTRAL RULE. A screenshot is re-attachable from disk; the sentence
    // beside it exists nowhere else.
    const items = [msg("q0", "fix the flaky test", MAX_QUEUE_BYTES * 2)];
    const fit = fitToBudget(items, strip);
    expect(fit.shedAttachments).toBe(true);
    expect(fit.droppedCount).toBe(0);
    expect(fit.items.map((m) => m.text)).toEqual(["fix the flaky test"]);
    expect(fit.items[0].files).toBeUndefined();
  });

  test("one oversized attachment does not cost a SIBLING message its own", () => {
    // Stripping is all-or-nothing by design (simpler, and predictable), so this
    // pins the cost that choice accepts: both lose attachments, neither loses
    // text. If that ever becomes per-message, this test is the one to revisit.
    const items = [msg("q0", "small", 10), msg("q1", "huge", MAX_QUEUE_BYTES * 2)];
    const fit = fitToBudget(items, strip);
    expect(fit.items.map((m) => m.text)).toEqual(["small", "huge"]);
    expect(fit.items.every((m) => m.files === undefined)).toBe(true);
  });

  test("when even bare text overflows, the OLDEST messages go first", () => {
    // The newest message is the one still on the user's mind.
    const items = [msg("q0", "a".repeat(400)), msg("q1", "b".repeat(400)), msg("q2", "c".repeat(400))];
    const fit = fitToBudget(items, strip, 600);
    expect(fit.droppedCount).toBeGreaterThan(0);
    expect(fit.items.at(-1)?.id).toBe("q2");
    expect(fit.items.map((m) => m.id)).not.toContain("q0");
  });

  test("eviction terminates rather than looping on an unfittable single message", () => {
    const fit = fitToBudget([msg("q0", "z".repeat(5_000))], strip, 100);
    expect(fit.items).toEqual([]);
    expect(fit.droppedCount).toBe(1);
  });

  test("an empty queue is a no-op", () => {
    expect(fitToBudget([], strip)).toEqual({ items: [], shedAttachments: false, droppedCount: 0 });
  });

  test("byte budget is measured in UTF-8, not UTF-16 code units", () => {
    // "𝕏" is 4 UTF-8 bytes but 2 `.length` units. Measuring with `.length`
    // would let a queue of astral text sail past a quota it actually exceeds.
    const items = [msg("q0", "𝕏".repeat(100))];
    const underByLength = fitToBudget(items, strip, 250);
    expect(underByLength.droppedCount).toBe(1);
  });
});

describe("readQueue — a corrupt key must never block a session from opening", () => {
  test("round-trips what writeQueue stored", () => {
    const storage = fakeStorage();
    const items = [msg("q0", "one"), msg("q1", "two")];
    writeQueue(storage, "k", items, strip);
    expect(readQueue<Msg>(storage, "k")).toEqual(items);
  });

  test("missing key reads empty", () => {
    expect(readQueue(fakeStorage(), "nope")).toEqual([]);
  });

  test("malformed JSON reads empty instead of throwing", () => {
    const storage = fakeStorage();
    storage.setItem("k", "{not json");
    expect(readQueue(storage, "k")).toEqual([]);
  });

  test("a non-array value reads empty", () => {
    const storage = fakeStorage();
    storage.setItem("k", JSON.stringify({ hijacked: true }));
    expect(readQueue(storage, "k")).toEqual([]);
  });

  test("no storage at all (SSR) reads empty", () => {
    expect(readQueue(undefined, "k")).toEqual([]);
  });
});

describe("writeQueue — quota failures degrade, they do not throw", () => {
  test("an empty queue REMOVES the key rather than leaving a tombstone", () => {
    const storage = fakeStorage();
    writeQueue(storage, "k", [msg("q0", "hi")], strip);
    expect(storage.map.has("k")).toBe(true);
    writeQueue(storage, "k", [], strip);
    expect(storage.map.has("k")).toBe(false);
  });

  test("a quota rejection despite our own budget falls back to text-only", () => {
    // Another tab filled the origin between our measurement and our write.
    const storage = fakeStorage({ failSetItem: true });
    const fit = writeQueue(storage, "k", [msg("q0", "keep me", 10)], strip);
    expect(fit.shedAttachments).toBe(true);
    // Nothing was stored (the double throws too) but the call RETURNED — the
    // queue survives in memory for this session rather than crashing a render.
    expect(fit.droppedCount).toBe(1);
  });

  test("no storage still reports the fit, so callers can warn without a DOM", () => {
    const fit = writeQueue(undefined, "k", [msg("q0", "x", MAX_QUEUE_BYTES * 2)], strip);
    expect(fit.shedAttachments).toBe(true);
    expect(fit.items[0].text).toBe("x");
  });
});

// ── the ArrowUp/ArrowDown walk (message-lifecycle F1) ────────────────────────
// A pure index over the EDITABLE lines, re-resolved per press. The walk's
// contract: up from rest lands on the newest, further ups clamp at the oldest,
// down walks back, and down past the newest ENDS the walk (cursor null) so the
// caller restores the displaced draft. Non-editable lines are never targets.

// The import sits here rather than at the top so the walk's block reads as one
// unit — same file, same runtime, purely an organizational choice.
import { recallTarget, type PendingLine } from "./message-queue";

const line = (id: string, editable = true): PendingLine<{ id: string }> => ({
  item: { id },
  editable,
});

describe("recallTarget — the composer's walk over the strip", () => {
  const lines = [line("oldest"), line("mid"), line("newest")];

  test("up from rest lands on the NEWEST editable line", () => {
    const step = recallTarget(lines, null, "up");
    expect(step.cursor).toBe(2);
    expect(step.line?.item.id).toBe("newest");
  });

  test("repeated up walks older and CLAMPS at the oldest — no wrap", () => {
    expect(recallTarget(lines, 2, "up").line?.item.id).toBe("mid");
    expect(recallTarget(lines, 1, "up").line?.item.id).toBe("oldest");
    expect(recallTarget(lines, 0, "up").line?.item.id).toBe("oldest");
    expect(recallTarget(lines, 0, "up").cursor).toBe(0);
  });

  test("down walks back toward newest; past the newest the walk ENDS", () => {
    expect(recallTarget(lines, 0, "down").line?.item.id).toBe("mid");
    expect(recallTarget(lines, 1, "down").line?.item.id).toBe("newest");
    const out = recallTarget(lines, 2, "down");
    expect(out.cursor).toBeNull();
    expect(out.line).toBeNull();
  });

  test("down at rest is a no-op — there is no walk to walk back through", () => {
    expect(recallTarget(lines, null, "down")).toEqual({ cursor: null, line: null });
  });

  test("non-editable lines are invisible to the walk", () => {
    const mixed = [line("a"), line("failed", false), line("b")];
    expect(recallTarget(mixed, null, "up").line?.item.id).toBe("b");
    expect(recallTarget(mixed, 1, "up").line?.item.id).toBe("a");
  });

  test("an empty (or fully non-editable) strip recalls nothing", () => {
    expect(recallTarget([], null, "up")).toEqual({ cursor: null, line: null });
    expect(recallTarget([line("x", false)], null, "up")).toEqual({ cursor: null, line: null });
  });
});
