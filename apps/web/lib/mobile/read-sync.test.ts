// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { signalKey, type Delivery, type DeliveryResult, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import { collectReads, noteAlert, READ_SYNC_BATCH, READ_SYNC_INTERVAL_S, readCleared, readSyncDelivery } from "./read-sync";
import { relayDelivery } from "./relay";
import { v2Body } from "./relay-v2";
import { deliverRecord, readSyncPass } from "./worker";

const registration: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789ABC", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: false,
  enabled: true, completions: true, previews: true, mutedSessions: [], activities: [],
};
const working = (id: string): SessionSignal => ({ id, title: `Secret title ${id}`, activity: "working", activityAt: 1000, lastTurnSequence: 1, lastReadTurnSequence: 1 });
const finished = (id: string): SessionSignal => ({ ...working(id), activity: "idle", lastTurnEndedAt: 2000, lastTurnSequence: 2 });
const read = (session: SessionSignal): SessionSignal => ({ ...session, lastReadTurnSequence: session.lastTurnSequence });
const record = (sessions: SessionSignal[], patch: Partial<PushRecord> = {}): PushRecord => ({
  ...registration, deviceId: "paired", revision: "r1", updatedAt: 1000, baselined: true,
  seen: Object.fromEntries(sessions.map(s => [s.id, signalKey(s)])), activitySent: {}, ...patch,
});
function recorder(answer: (delivery: Delivery) => DeliveryResult = () => ({ status: 200 })) {
  const sent: Delivery[] = [];
  return { sent, send: async (delivery: Delivery) => { sent.push(delivery); return answer(delivery); } };
}
const background = (sent: Delivery[]) => sent.filter(d => d.kind === "background");

describe("what counts as read", () => {
  test("the engine's unread pair decides, and a session waiting on the person is never cleared", () => {
    expect(readCleared(finished("a"))).toBe(false);
    expect(readCleared(read(finished("a")))).toBe(true);
    expect(readCleared({ ...read(finished("a")), activity: "blocked" })).toBe(false);
    // Never produced a result: nothing to read, so nothing to keep up.
    expect(readCleared({ activity: "idle" })).toBe(true);
  });
});

describe("the silent push", () => {
  test("is background, silent, to the app's own bundle, and carries ids only", () => {
    const delivery = readSyncDelivery(registration, ["a", "b"]);
    expect(delivery.kind).toBe("background");
    expect(delivery.topic).toBe("com.telar.mobile");
    expect(delivery.token).toBe(registration.token);
    expect(delivery.payload).toEqual({ aps: { "content-available": 1 }, read: { host: registration.hostId, sessions: ["a", "b"] } });
    expect(JSON.stringify(delivery.payload)).not.toContain("Secret");
    // Relay v2 carries it as a kind of its own; v1 is being retired and refuses it.
    expect(v2Body(delivery)).toEqual({ kind: "background", collapseId: delivery.collapseId, payload: delivery.payload });
  });
  test("relay v1 never carries one", async () => {
    let called = false;
    const config = { url: "https://relay.invalid", hostId: "h", secret: "s" } as unknown as Parameters<typeof relayDelivery>[0];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    try {
      expect(await relayDelivery(config, record([]), readSyncDelivery(registration, ["a"]))).toEqual({ status: 400, relay: true });
    } finally { globalThis.fetch = original; }
    expect(called).toBe(false);
  });
});

describe("coalescing and the one-a-minute limit", () => {
  test("only a session this phone was alerted about is ever cleared", async () => {
    const quiet = working("quiet");
    const { sent, send } = recorder();
    // `quiet` was read on the Mac, but the phone never got an alert for it.
    const next = await deliverRecord(record([quiet]), [read(quiet)], send, 10_000, { readSync: true });
    expect(background(sent)).toEqual([]);
    expect(next?.readSync).toBeUndefined();
  });

  test("reads within a minute ride one push; the rest wait for the next minute", async () => {
    const [a, b, c] = ["a", "b", "c"].map(working);
    const { sent, send } = recorder();
    let current = record([a, b, c]);
    let now = 10_000;
    // Three alerts go out and are tracked.
    current = (await deliverRecord(current, [finished("a"), finished("b"), finished("c")], send, now, { readSync: true }))!;
    expect(current.readSync?.alerted).toEqual(["a", "b", "c"]);
    // Two are read on the Mac in the same sweep: ONE push names both.
    now += 5;
    current = (await deliverRecord(current, [read(finished("a")), read(finished("b")), finished("c")], send, now, { readSync: true }))!;
    expect(background(sent).map(d => d.payload.read?.sessions)).toEqual([["a", "b"]]);
    // The third is read seconds later: held, not sent.
    now += 10;
    const all = [read(finished("a")), read(finished("b")), read(finished("c"))];
    current = (await deliverRecord(current, all, send, now, { readSync: true }))!;
    expect(background(sent)).toHaveLength(1);
    expect(current.readSync?.pending).toEqual(["c"]);
    expect(readSyncPass([current], all, now)).toEqual({ due: false, waiting: true });
    // A minute after the last push it goes, with nothing else to trigger it.
    now = 10_005 + READ_SYNC_INTERVAL_S;
    expect(readSyncPass([current], all, now)).toEqual({ due: true, waiting: true });
    current = (await deliverRecord(current, all, send, now, { readSync: true, changed: new Set() }))!;
    expect(background(sent).map(d => d.payload.read?.sessions)).toEqual([["a", "b"], ["c"]]);
    expect(current.readSync).toEqual({ alerted: [], pending: [], sentAt: now });
  });

  test("a big sweep is split into bounded batches, a minute apart", async () => {
    const ids = Array.from({ length: READ_SYNC_BATCH + 3 }, (_, n) => `s${n}`);
    let state = { alerted: [] as string[], pending: [] as string[] };
    for (const id of ids) state = noteAlert(state, id);
    const { sent, send } = recorder();
    const sessions = ids.map(id => read(finished(id)));
    const first = (await deliverRecord(record(sessions, { readSync: state }), sessions, send, 10_000, { readSync: true }))!;
    expect(background(sent)[0].payload.read?.sessions).toHaveLength(READ_SYNC_BATCH);
    expect(first.readSync?.pending).toHaveLength(3);
  });

  test("a new alert for a session supersedes its pending clear", () => {
    const pending = { alerted: [], pending: ["a"], sentAt: 1 };
    expect(noteAlert(pending, "a")).toEqual({ alerted: ["a"], pending: [], sentAt: 1 });
    // A session that is gone is forgotten rather than cleared.
    expect(collectReads({ alerted: ["gone"], pending: [] }, [])).toEqual({ alerted: [], pending: [] });
  });

  test("a failed push is retried next minute and never delays alerts with backoff", async () => {
    const { sent, send } = recorder(d => d.kind === "background" ? { status: 429, relay: true } : { status: 200 });
    const state = { alerted: ["a"], pending: [] };
    const next = (await deliverRecord(record([finished("a")], { readSync: state }), [read(finished("a"))], send, 10_000, { readSync: true }))!;
    expect(background(sent)).toHaveLength(1);
    expect(next.readSync).toEqual({ alerted: [], pending: ["a"], sentAt: 10_000 });
    expect(next.failures).toBe(0);
    expect(next.retryAt).toBeUndefined();
  });

  test("a dead token found by a silent push drops the record, like an alert's", async () => {
    const { send } = recorder(() => ({ status: 410 }));
    const state = { alerted: ["a"], pending: [] };
    expect(await deliverRecord(record([finished("a")], { readSync: state }), [read(finished("a"))], send, 10_000, { readSync: true })).toBeUndefined();
  });

  test("a relay v1 phone gets no read sync and keeps no state for it", async () => {
    const { sent, send } = recorder();
    const next = (await deliverRecord(record([working("a")], { readSync: { alerted: ["a"], pending: ["a"] } }), [finished("a")], send, 10_000, { readSync: false }))!;
    expect(background(sent)).toEqual([]);
    expect(next.readSync).toBeUndefined();
  });
});
