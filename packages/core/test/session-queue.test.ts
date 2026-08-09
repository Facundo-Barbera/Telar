import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-queue-"));
const originalHome = process.env.TELAR_HOME;
process.env.TELAR_HOME = home;

const queue = await import("../src/session-queue");

beforeEach(() => {
  process.env.TELAR_HOME = home;
  fs.rmSync(path.join(home, "sessions"), { recursive: true, force: true });
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const clock = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
};

describe("engine-owned durable session queue", () => {
  test("a missing queue is a complete empty envelope and does not create files", () => {
    expect(queue.readSessionQueue("s-empty")).toEqual({
      schemaVersion: 1,
      sessionId: "s-empty",
      revision: 0,
      nextSequence: 0,
      paused: false,
      items: [],
    });
    expect(fs.existsSync(queue.sessionQueueFile("s-empty"))).toBe(false);
  });

  test("persists the complete generic JSON payload under the guarded session directory", () => {
    const payload = {
      message: "inspect this",
      attachments: [{ id: "a1", meta: { mediaType: "image/png", size: 42 } }],
      flags: [true, false, null],
      tuning: { temperature: 0.25 },
    } as const;
    const item = queue.enqueueSessionTurn(
      "s-json",
      { idempotencyKey: "client-1", payload },
      () => 100,
    );

    expect(item.payload).toEqual(payload);
    expect(queue.sessionQueueFile("s-json")).toBe(
      path.join(home, "sessions", "s-json", "queue.json"),
    );
    expect(queue.readSessionQueue("s-json").items[0]?.payload).toEqual(payload);
    expect(fs.readdirSync(path.dirname(queue.sessionQueueFile("s-json")))).toEqual(["queue.json"]);
  });

  test("rejects incomplete or lossy JSON rather than silently dropping fields", () => {
    expect(() =>
      queue.enqueueSessionTurn("s-bad", {
        idempotencyKey: "bad",
        payload: { omitted: undefined } as never,
      }),
    ).toThrow(/complete JSON/);
    expect(() =>
      queue.enqueueSessionTurn("s-bad", {
        idempotencyKey: "nan",
        payload: { value: Number.NaN } as never,
      }),
    ).toThrow(/non-finite/);
    expect(() =>
      queue.enqueueSessionTurn("s-bad", {
        idempotencyKey: "date",
        payload: { when: new Date(0) } as never,
      }),
    ).toThrow(/non-JSON object/);
    const sparse = Array(2) as never;
    expect(() =>
      queue.enqueueSessionTurn("s-bad", { idempotencyKey: "sparse", payload: sparse }),
    ).toThrow(/sparse array/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      queue.enqueueSessionTurn("s-bad", { idempotencyKey: "cycle", payload: cyclic as never }),
    ).toThrow(/cycle/);
  });

  test("enqueue is idempotent by the stable client key and does not overwrite payload", () => {
    const first = queue.enqueueSessionTurn(
      "s-idem",
      { idempotencyKey: "request-7", payload: { text: "first" } },
      () => 10,
    );
    const duplicate = queue.enqueueSessionTurn(
      "s-idem",
      { idempotencyKey: "request-7", payload: { text: "different retry body" } },
      () => 20,
    );

    expect(duplicate).toEqual(first);
    const envelope = queue.readSessionQueue("s-idem");
    expect(envelope.revision).toBe(1);
    expect(envelope.nextSequence).toBe(1);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.payload).toEqual({ text: "first" });
  });

  test("a queue.json written before machinery tickets still parses and claims", () => {
    const file = queue.sessionQueueFile("s-legacy");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "s-legacy",
        revision: 4,
        nextSequence: 1,
        paused: false,
        items: [
          {
            idempotencyKey: "pre-machinery",
            sequence: 0,
            revision: 0,
            state: "queued",
            payload: { text: "queued before kinds existed" },
            acceptedAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );

    const stored = queue.readSessionQueue("s-legacy").items[0]!;
    expect(stored.kind).toBeUndefined();
    expect(stored.hidden).toBeUndefined();
    expect(queue.sessionTurnKind(stored)).toBe("user");

    const claimed = queue.claimNextSessionTurn("s-legacy", "engine", () => 5)!;
    expect(claimed.item.idempotencyKey).toBe("pre-machinery");
    expect(claimed.item.state).toBe("claimed");
    expect(queue.sessionTurnKind(claimed.item)).toBe("user");
  });

  test("machinery kind and hidden round-trip enqueue, claim and reload", () => {
    const wake = queue.enqueueSessionTurn(
      "s-kind",
      {
        idempotencyKey: "ultra:run-3:done",
        payload: { text: "ultra sweep finished" },
        kind: "wake",
        hidden: true,
      },
      () => 10,
    );
    const plain = queue.enqueueSessionTurn(
      "s-kind",
      { idempotencyKey: "typed-user", payload: { text: "hi" }, kind: "user", hidden: false },
      () => 11,
    );
    expect(wake.kind).toBe("wake");
    expect(wake.hidden).toBe(true);
    // "absent means user" only stays true while the default is never written
    // back: one item shape on disk, whichever version of the code wrote it.
    expect(plain.kind).toBeUndefined();
    expect(plain.hidden).toBeUndefined();
    expect(queue.sessionTurnKind(plain)).toBe("user");

    const claimed = queue.claimNextSessionTurn("s-kind", "engine", () => 12)!;
    expect(claimed.item.idempotencyKey).toBe("ultra:run-3:done");
    expect(claimed.item.kind).toBe("wake");
    expect(claimed.item.hidden).toBe(true);

    const raw = JSON.parse(fs.readFileSync(queue.sessionQueueFile("s-kind"), "utf8"));
    expect(raw.items[0].kind).toBe("wake");
    expect(raw.items[0].hidden).toBe(true);
    expect(Object.keys(raw.items[1])).not.toContain("kind");
    expect(Object.keys(raw.items[1])).not.toContain("hidden");

    const reloaded = queue.readSessionQueue("s-kind").items[0]!;
    expect(reloaded.kind).toBe("wake");
    expect(reloaded.hidden).toBe(true);
  });

  test("one event can produce one ticket: a re-fired wake returns the first item", () => {
    const first = queue.enqueueSessionTurn(
      "s-wake-idem",
      {
        idempotencyKey: "ultra:run-3:done",
        payload: { text: "sweep finished" },
        kind: "wake",
        hidden: true,
      },
      () => 10,
    );
    const refired = queue.enqueueSessionTurn(
      "s-wake-idem",
      {
        idempotencyKey: "ultra:run-3:done",
        payload: { text: "sweep finished (redelivered)" },
        kind: "wake",
        hidden: true,
      },
      () => 20,
    );
    expect(refired).toEqual(first);
    // Nor can a redelivery under a different kind reclassify the ticket the
    // event already owns — the key IS the event.
    expect(
      queue.enqueueSessionTurn("s-wake-idem", { idempotencyKey: "ultra:run-3:done", payload: null }),
    ).toEqual(first);

    const envelope = queue.readSessionQueue("s-wake-idem");
    expect(envelope.revision).toBe(1);
    expect(envelope.nextSequence).toBe(1);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0]?.payload).toEqual({ text: "sweep finished" });
  });

  test("adopts a canonical key without replacing the stable client key", () => {
    queue.enqueueSessionTurn(
      "s-adopt",
      { idempotencyKey: "client-key", payload: { text: "hello" } },
      () => 10,
    );
    const adopted = queue.adoptSessionTurnCanonicalKey(
      "s-adopt",
      "client-key",
      "engine-run-9",
      0,
      () => 11,
    );
    expect(adopted.idempotencyKey).toBe("client-key");
    expect(adopted.canonicalKey).toBe("engine-run-9");
    expect(adopted.revision).toBe(1);

    // Either identity resolves to the same durable record, including retries
    // that arrive after the engine has learned its canonical identity.
    expect(
      queue.enqueueSessionTurn("s-adopt", {
        idempotencyKey: "engine-run-9",
        payload: { text: "retry" },
      }),
    ).toEqual(adopted);
    expect(queue.readSessionQueue("s-adopt").items).toHaveLength(1);
  });

  test("canonical adoption rejects stale revisions and collisions", () => {
    queue.enqueueSessionTurn("s-adopt-conflict", { idempotencyKey: "a", payload: null });
    queue.enqueueSessionTurn("s-adopt-conflict", {
      idempotencyKey: "b",
      canonicalKey: "canonical-b",
      payload: null,
    });
    expect(() =>
      queue.adoptSessionTurnCanonicalKey("s-adopt-conflict", "a", "new", 99),
    ).toThrow(/revision conflict/);
    expect(() =>
      queue.adoptSessionTurnCanonicalKey("s-adopt-conflict", "a", "canonical-b", 0),
    ).toThrow(/already owned/);
  });

  test("a canonical key equal to the stable key is normalized to one identity", () => {
    const item = queue.enqueueSessionTurn("s-same-key", {
      idempotencyKey: "same",
      canonicalKey: "same",
      payload: null,
    });
    expect(item.canonicalKey).toBeUndefined();
    expect(
      queue.adoptSessionTurnCanonicalKey("s-same-key", "same", "same", 0),
    ).toEqual(item);
    expect(queue.readSessionQueue("s-same-key").items).toEqual([item]);
  });

  test("claims queued work strictly FIFO and permits only one active claim", () => {
    for (const key of ["one", "two", "three"]) {
      queue.enqueueSessionTurn("s-fifo", { idempotencyKey: key, payload: { key } });
    }

    const first = queue.claimNextSessionTurn("s-fifo", "engine-A", () => 50);
    expect(first?.item.idempotencyKey).toBe("one");
    expect(first?.item.state).toBe("claimed");
    expect(queue.claimNextSessionTurn("s-fifo", "engine-B")).toBeNull();

    const running = queue.markSessionTurnRunning(
      "s-fifo",
      "one",
      first!.claimToken,
      () => 60,
    );
    expect(running.state).toBe("running");
    expect(running.startedAt).toBe(60);
    expect(queue.claimNextSessionTurn("s-fifo", "engine-B")).toBeNull();

    expect(queue.commitSessionTurn("s-fifo", "one", first!.claimToken, () => 70).state).toBe(
      "committed",
    );
    expect(queue.claimNextSessionTurn("s-fifo", "engine-B")?.item.idempotencyKey).toBe("two");
  });

  test("claim token is required for execution transitions", () => {
    queue.enqueueSessionTurn("s-token", { idempotencyKey: "x", payload: null });
    const claim = queue.claimNextSessionTurn("s-token", "engine")!;
    expect(() => queue.markSessionTurnRunning("s-token", "x", "wrong")).toThrow(/token mismatch/);
    expect(() => queue.commitSessionTurn("s-token", "x", claim.claimToken)).toThrow(
      /cannot transition claimed to committed/,
    );
  });

  test("pause blocks claims and resume preserves FIFO", () => {
    queue.enqueueSessionTurn("s-pause", { idempotencyKey: "a", payload: null });
    expect(queue.pauseSessionQueue("s-pause").paused).toBe(true);
    expect(queue.claimNextSessionTurn("s-pause", "engine")).toBeNull();
    expect(queue.resumeSessionQueue("s-pause").paused).toBe(false);
    expect(queue.claimNextSessionTurn("s-pause", "engine")?.item.idempotencyKey).toBe("a");
  });

  test("queued-only edit and cancel enforce optimistic item revisions", () => {
    queue.enqueueSessionTurn("s-edit", { idempotencyKey: "a", payload: { text: "old" } });
    const edited = queue.editQueuedSessionTurn(
      "s-edit",
      "a",
      { text: "new", files: ["f1"] },
      0,
      () => 20,
    );
    expect(edited.payload).toEqual({ text: "new", files: ["f1"] });
    expect(edited.revision).toBe(1);
    expect(() => queue.cancelQueuedSessionTurn("s-edit", "a", 0)).toThrow(/revision conflict/);
    expect(queue.cancelQueuedSessionTurn("s-edit", "a", 1, () => 30).state).toBe("cancelled");

    queue.enqueueSessionTurn("s-edit", { idempotencyKey: "b", payload: null });
    const claim = queue.claimNextSessionTurn("s-edit", "engine")!;
    expect(() => queue.editQueuedSessionTurn("s-edit", "b", { changed: true }, 1)).toThrow(
      /only queued items/,
    );
    expect(() => queue.cancelQueuedSessionTurn("s-edit", "b", 1)).toThrow(/only queued items/);
    expect(claim.item.idempotencyKey).toBe("b");
  });

  test("failure is terminal and records the engine error", () => {
    queue.enqueueSessionTurn("s-fail", { idempotencyKey: "a", payload: null });
    const claim = queue.claimNextSessionTurn("s-fail", "engine")!;
    const failed = queue.failSessionTurn(
      "s-fail",
      "a",
      claim.claimToken,
      "profile rejected",
      () => 90,
    );
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("profile rejected");
    expect(failed.settledAt).toBe(90);
  });

  test("a settled failure can be dismissed by a human, and only a settled failure", () => {
    // Nothing transitions out of `failed`/`ambiguous`, so before this the item
    // stayed in the envelope for the life of the session and the surface that
    // must show it ("a message that did not send may not vanish") could never
    // be emptied: its remove button reached cancelQueuedSessionTurn and 409'd.
    queue.enqueueSessionTurn("s-dismiss", { idempotencyKey: "a", payload: null });
    const claim = queue.claimNextSessionTurn("s-dismiss", "engine")!;
    const failed = queue.failSessionTurn("s-dismiss", "a", claim.claimToken, "boom");
    // The two transitions stay apart: retracting work that never started is a
    // different claim from acknowledging work that may have reached a provider.
    expect(() => queue.cancelQueuedSessionTurn("s-dismiss", "a", failed.revision)).toThrow(
      /only queued items/,
    );
    expect(() => queue.dismissFailedSessionTurn("s-dismiss", "a", failed.revision - 1)).toThrow(
      /revision conflict/,
    );
    const dismissed = queue.dismissFailedSessionTurn("s-dismiss", "a", failed.revision, () => 120);
    expect(dismissed.state).toBe("cancelled");
    expect(dismissed.settledAt).toBe(120);
    // The reason survives the dismissal — history that drops why it exists is
    // worse than none.
    expect(dismissed.error).toBe("boom");
    // And a queue paused BEHIND that failure stays paused: clearing the
    // evidence is not the same act as saying "continue".
    queue.pauseSessionQueue("s-dismiss");
    queue.enqueueSessionTurn("s-dismiss", { idempotencyKey: "b", payload: null });
    const bFailed = (() => {
      queue.resumeSessionQueue("s-dismiss");
      const c = queue.claimNextSessionTurn("s-dismiss", "engine")!;
      return queue.failSessionTurn("s-dismiss", "b", c.claimToken, "boom again");
    })();
    queue.pauseSessionQueue("s-dismiss");
    queue.dismissFailedSessionTurn("s-dismiss", "b", bFailed.revision);
    expect(queue.readSessionQueue("s-dismiss").paused).toBe(true);
  });

  test("dismissal refuses every state the engine may still act on", () => {
    queue.enqueueSessionTurn("s-dismiss-guard", { idempotencyKey: "a", payload: null });
    // `queued` — cancelQueuedSessionTurn owns this one, and mistaking the two
    // would let a "dismiss" retract a message that is still going to send.
    expect(() => queue.dismissFailedSessionTurn("s-dismiss-guard", "a", 0)).toThrow(
      /only failed or ambiguous/,
    );
    const claim = queue.claimNextSessionTurn("s-dismiss-guard", "engine")!;
    queue.markSessionTurnRunning("s-dismiss-guard", "a", claim.claimToken);
    const running = queue.readSessionQueue("s-dismiss-guard").items[0]!;
    expect(() =>
      queue.dismissFailedSessionTurn("s-dismiss-guard", "a", running.revision),
    ).toThrow(/only failed or ambiguous/);
    expect(() => queue.dismissFailedSessionTurn("s-dismiss-guard", "nope", 0)).toThrow(
      /unknown queue item/,
    );
  });

  test("recovery requeues definitely-unstarted claims but never replays running work", () => {
    for (const key of ["unstarted", "started", "later"]) {
      queue.enqueueSessionTurn("s-recover", { idempotencyKey: key, payload: { key } });
    }

    const unstarted = queue.claimNextSessionTurn("s-recover", "dead-engine", () => 10)!;
    const recoveredClaim = queue.recoverSessionQueue("s-recover", () => 20);
    expect(recoveredClaim.requeued).toEqual(["unstarted"]);
    expect(recoveredClaim.ambiguous).toEqual([]);
    expect(recoveredClaim.envelope.items[0]?.state).toBe("queued");

    const started = queue.claimNextSessionTurn("s-recover", "new-engine", () => 30)!;
    expect(started.item.idempotencyKey).toBe("unstarted");
    queue.markSessionTurnRunning("s-recover", "unstarted", started.claimToken, () => 40);
    const recoveredRun = queue.recoverSessionQueue("s-recover", () => 50);
    expect(recoveredRun.requeued).toEqual([]);
    expect(recoveredRun.ambiguous).toEqual(["unstarted"]);
    const item = recoveredRun.envelope.items[0]!;
    expect(item.state).toBe("ambiguous");
    expect(item.error).toMatch(/may have already made changes/);

    // Uncertain work bars later intent — but as the MESSAGE's own unanswered
    // question, never as a session-level paused mode (feel contract rule 13).
    // The queue is NOT paused; claiming simply holds while the ambiguous item
    // awaits its human answer, and answering it (here: Discard) releases the
    // barrier with no Resume act anywhere.
    expect(recoveredRun.envelope.paused).toBe(false);
    expect(queue.claimNextSessionTurn("s-recover", "new-engine")).toBeNull();
    queue.dismissFailedSessionTurn("s-recover", "unstarted", item.revision);
    expect(queue.claimNextSessionTurn("s-recover", "new-engine")?.item.idempotencyKey).toBe("started");
    expect(unstarted.item.state).toBe("claimed");
  });

  test("discovers only guarded session directories that own a queue", () => {
    queue.enqueueSessionTurn("s-discovery-b", { idempotencyKey: "b", payload: null });
    queue.enqueueSessionTurn("s-discovery-a", { idempotencyKey: "a", payload: null });
    fs.mkdirSync(path.join(home, "sessions", "no-queue"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "plain-file"), "x");
    expect(queue.listSessionQueueIds()).toEqual(["s-discovery-a", "s-discovery-b"]);
  });

  test("writes are atomic snapshots and leave no temporary residue", () => {
    const times = clock(1, 2, 3);
    queue.enqueueSessionTurn("s-atomic", { idempotencyKey: "a", payload: null }, times);
    queue.enqueueSessionTurn("s-atomic", { idempotencyKey: "b", payload: null }, times);
    queue.pauseSessionQueue("s-atomic");
    const dir = path.dirname(queue.sessionQueueFile("s-atomic"));
    expect(fs.readdirSync(dir)).toEqual(["queue.json"]);
    expect(JSON.parse(fs.readFileSync(queue.sessionQueueFile("s-atomic"), "utf8")).items).toHaveLength(2);
  });

  test("corrupt state fails closed instead of being mistaken for an empty queue", () => {
    const file = queue.sessionQueueFile("s-corrupt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    expect(() => queue.readSessionQueue("s-corrupt")).toThrow(queue.SessionQueueCorruptError);

    // An unreadable kind is not a user turn by omission: a ticket authored by
    // machinery this build does not know about must not be run as one.
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        sessionId: "s-corrupt",
        revision: 1,
        nextSequence: 1,
        paused: false,
        items: [
          {
            idempotencyKey: "a",
            sequence: 0,
            revision: 0,
            state: "queued",
            payload: null,
            kind: "loom",
            acceptedAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(() => queue.readSessionQueue("s-corrupt")).toThrow(queue.SessionQueueCorruptError);
  });

  test("session id traversal is rejected by the shared sessionDir guard", () => {
    expect(() => queue.readSessionQueue("../../escape")).toThrow(/invalid session id/);
    expect(() =>
      queue.enqueueSessionTurn("a/b", { idempotencyKey: "x", payload: null }),
    ).toThrow(/invalid session id/);
  });
});
