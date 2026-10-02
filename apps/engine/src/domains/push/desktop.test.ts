import { describe, expect, test } from "bun:test";
import type http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_NOTIFY_ON, NOTIFY_ON_VALUES, type EngineClient, type NotifyOn } from "@telar/engine-client";
import { matchRoute } from "../../platform/http/router";
import {
  DESKTOP_APPROVE, DESKTOP_APPROVED, DESKTOP_DISMISS, DESKTOP_NOTICE, DESKTOP_PRESENCE, PRESENCE_STALE_MS,
  createDesktopStream, desktopAttached, desktopNotices, dismissDesktop, emptyDesktopState, handleDesktopMessage, macTookAlert, noteConnectedMac, notifyDesktop, notifyRoute,
  type DesktopState, type Presence,
} from "./desktop";
import { readNotifyOn, readSounds, writeNotifyOn, writeSounds } from "./prefs";
import { notification, signalKey, soundFor, type Delivery, type DeliveryResult, type MobileRegistration, type PushRecord, type SessionSignal } from "./push";
import { pushRoutes } from "./routes";
import { deliverRecord } from "./worker";

const working: SessionSignal = { id: "s1", title: "Private repository task", activity: "working", activityAt: 1000, projectId: "p1" };
const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
const finished: SessionSignal = { ...working, activity: "idle", activityAt: 3000, lastTurnEndedAt: 3000 };
const failed: SessionSignal = { ...finished, lastTurnFailed: true };

function pass(state: DesktopState, sessions: SessionSignal[], changed?: Set<string>) {
  return desktopNotices(state, sessions, changed);
}

describe("which transitions reach the Mac", () => {
  test("the first pass baselines: a launch never replays history", () => {
    const { notices, state } = pass(emptyDesktopState(), [blocked, failed]);
    expect(notices).toEqual([]);
    expect(state.baselined).toBe(true);
  });

  test("blocked, finished and failed each fire once per transition", () => {
    let { state } = pass(emptyDesktopState(), [working]);
    const toBlocked = pass(state, [blocked]);
    expect(toBlocked.notices.map((n) => n.kind)).toEqual(["blocked"]);
    expect(pass(toBlocked.state, [blocked]).notices).toEqual([]);
    ({ state } = pass(toBlocked.state, [working]));
    expect(pass(state, [finished]).notices.map((n) => n.kind)).toEqual(["finished"]);
    expect(pass(state, [failed]).notices.map((n) => n.kind)).toEqual(["failed"]);
  });

  test("a session created after the baseline alerts on first sight", () => {
    const { state } = pass(emptyDesktopState(), []);
    expect(pass(state, [blocked]).notices).toHaveLength(1);
  });

  test("an unchanged session outside the change set is skipped, as a phone record skips it", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    const moved = { ...blocked, id: "s2" };
    const next = pass({ ...state, seen: { ...state.seen, s2: "stale" } }, [blocked, moved], new Set(["s2"]));
    expect(next.notices.map((n) => n.sessionId)).toEqual(["s2"]);
  });

  test("agrees with the phone's rule, including the completions gate and the ungated failure", () => {
    const phone: MobileRegistration = { hostId: "h", token: "t", topic: "io.github.novarix.telar", sandbox: false, enabled: true, completions: false, previews: true, mutedSessions: [] };
    const { state } = pass(emptyDesktopState(), [working]);
    const prefs = { completions: false, previews: true };
    expect(desktopNotices(state, [finished], undefined, prefs).notices).toEqual([]);
    expect(notification(phone, finished, state.seen.s1)).toBeUndefined();
    expect(desktopNotices(state, [failed], undefined, prefs).notices).toHaveLength(1);
  });

  test("the title is the session's by default on the Mac, generic when previews are off", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    const [shown] = pass(state, [blocked]).notices;
    expect(shown).toMatchObject({ type: DESKTOP_NOTICE, title: "Private repository task", path: "/projects/p1/sessions/s1" });
    const [hidden] = desktopNotices(state, [blocked], undefined, { completions: true, previews: false }).notices;
    expect(hidden.title).toBe("Telar");
    expect(JSON.stringify(hidden)).not.toContain("Private");
  });

  test("a session with no project opens at /main", () => {
    const { state } = pass(emptyDesktopState(), [{ ...working, projectId: undefined }]);
    expect(pass(state, [{ ...blocked, projectId: undefined }]).notices[0].path).toBe("/main");
  });

  test("Approve is offered only for a single approvable request, and the offer retires when the session moves", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    expect(pass(state, [blocked]).notices[0].request).toBeUndefined();
    const offered = pass(state, [{ ...blocked, approvable: "r1" }]);
    expect(offered.notices[0].request).toBe("r1");
    expect(offered.state.offered).toEqual({ s1: "r1" });
    expect(pass(offered.state, [working]).state.offered).toEqual({});
    expect(pass(offered.state, []).state.offered).toEqual({});
  });
});

describe("the desktop stream", () => {
  const channel = () => {
    const sent: unknown[] = [];
    return { sent, connected: true, send: (message: unknown) => { sent.push(message); } };
  };

  test("is attached only while a shell is subscribed, and every subscriber gets each message as an event", () => {
    const stream = createDesktopStream();
    expect(desktopAttached(stream)).toBe(false);
    const first: string[] = [], second: string[] = [];
    const stopFirst = stream.subscribe({ write: (chunk) => first.push(chunk) });
    const stopSecond = stream.subscribe({ write: (chunk) => second.push(chunk) });
    expect(desktopAttached(stream)).toBe(true);
    stream.send({ type: DESKTOP_DISMISS, sessionId: "s1" });
    stopFirst();
    stream.send({ type: DESKTOP_DISMISS, sessionId: "s2" });
    stopSecond();
    expect(desktopAttached(stream)).toBe(false);
    expect(first).toEqual([`data: ${JSON.stringify({ type: DESKTOP_DISMISS, sessionId: "s1" })}\n\n`]);
    expect(second).toHaveLength(2);
    expect(desktopAttached({ ...channel(), connected: false })).toBe(false);
  });

  test("Approve resolves exactly the offered request, with accept, once", async () => {
    const state: DesktopState = { seen: {}, baselined: true, offered: { s1: "r1" } };
    const resolved: unknown[] = [];
    const resolve = async (...args: unknown[]) => { resolved.push(args); };
    const wire = channel();
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, resolve, wire, state);
    expect(resolved).toEqual([["s1", "r1", { decision: "accept" }]]);
    expect(wire.sent).toEqual([{ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: true }]);
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, resolve, wire, state);
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r2" }, resolve, wire, { ...state, offered: { s1: "r1" } });
    expect(resolved).toHaveLength(1);
    expect(wire.sent.slice(1)).toEqual([
      { type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: false },
      { type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r2", ok: false },
    ]);
  });

  test("a failed resolve answers not ok, and malformed messages are ignored", async () => {
    const wire = channel();
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, async () => { throw new Error("409"); }, wire, { seen: {}, baselined: true, offered: { s1: "r1" } });
    expect(wire.sent).toEqual([{ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: false }]);
    for (const junk of [null, "approve", { type: "other" }, { type: DESKTOP_APPROVE, sessionId: 1, requestId: "r1" }, { type: DESKTOP_APPROVE, sessionId: "s1", requestId: "" }]) {
      await handleDesktopMessage(junk, async () => { throw new Error("must not run"); }, wire, { seen: {}, baselined: true, offered: { s1: "r1" } });
    }
    expect(wire.sent).toHaveLength(1);
  });

  test("the shell's approve, posted to the engine, resolves through the engine client", async () => {
    const resolved: unknown[] = [];
    const client = { resolveRequest: async (...args: unknown[]) => { resolved.push(args); } } as unknown as EngineClient;
    const { route, params } = matchRoute(pushRoutes({ client: () => client, pairedDevices: () => [] }), "POST", "/v2/push/desktop/messages")!;
    const g = globalThis as { telarDesktopNotify?: DesktopState };
    const before = g.telarDesktopNotify;
    g.telarDesktopNotify = { seen: {}, baselined: true, offered: { s1: "r1" } };
    try {
      expect(await route.handle({ body: { type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, params, query: new URLSearchParams(), request: {} as http.IncomingMessage, response: {} as http.ServerResponse })).toEqual({ status: 200, body: { ok: true } });
      expect(resolved).toEqual([["s1", "r1", { decision: "accept" }]]);
    } finally { g.telarDesktopNotify = before; }
  });
});

describe("notify on: one alert, one device", () => {
  const PATH = "/projects/p1/sessions/s1";
  const now = 1_000_000;
  const presence = (patch: Partial<Presence> = {}): Presence => ({ active: true, viewingPath: null, at: now - 1000, ...patch });
  const cases: Array<[string, Presence | undefined]> = [
    ["active", presence()],
    ["idle or locked", presence({ active: false })],
    ["stale", presence({ at: now - PRESENCE_STALE_MS - 1 })],
    ["absent", undefined],
  ];
  const phoneOnly = { desktop: false, phone: true };
  const expected: Record<NotifyOn, Record<string, { desktop: boolean; phone: boolean }>> = {
    mac: { active: { desktop: true, phone: false }, "idle or locked": phoneOnly, stale: phoneOnly, absent: phoneOnly },
    iphone: { active: phoneOnly, "idle or locked": phoneOnly, stale: phoneOnly, absent: phoneOnly },
    both: Object.fromEntries(cases.map(([name]) => [name, { desktop: true, phone: true }])),
  };

  test("the matrix, not viewing the session", () => {
    for (const notifyOn of NOTIFY_ON_VALUES) {
      for (const [name, p] of cases) expect([notifyOn, name, notifyRoute(notifyOn, p, PATH, now)]).toEqual([notifyOn, name, expected[notifyOn][name]]);
    }
  });

  test("viewing that session while active silences both, except iPhone only, which always pushes", () => {
    const viewing = presence({ viewingPath: PATH });
    expect(notifyRoute("mac", viewing, PATH, now)).toEqual({ desktop: false, phone: false });
    expect(notifyRoute("both", viewing, PATH, now)).toEqual({ desktop: false, phone: false });
    expect(notifyRoute("iphone", viewing, PATH, now)).toEqual(phoneOnly);
    expect(notifyRoute("mac", presence({ viewingPath: "/projects/p1/sessions/s2" }), PATH, now)).toEqual({ desktop: true, phone: false });
  });

  test("a stale or idle 'viewing' never silences the phone: a window left open is not somebody looking", () => {
    expect(notifyRoute("mac", presence({ viewingPath: PATH, at: now - PRESENCE_STALE_MS - 1 }), PATH, now)).toEqual(phoneOnly);
    expect(notifyRoute("mac", presence({ viewingPath: PATH, active: false }), PATH, now)).toEqual(phoneOnly);
    expect(notifyRoute("mac", presence({ at: now + 60_000 }), PATH, now)).toEqual(phoneOnly);
    expect(notifyRoute("mac", presence({ at: now - PRESENCE_STALE_MS }), PATH, now)).toEqual({ desktop: true, phone: false });
  });

  test("the default is This Mac when active", () => {
    expect(DEFAULT_NOTIFY_ON).toBe("mac");
  });
});

const g = globalThis as { telarDesktopNotify?: DesktopState; telarDesktopPresence?: Presence; telarDesktopTook?: Record<string, string>; telarConnectedMacs?: Record<string, number> };
const recorder = () => ({ sent: [] as unknown[], connected: true, send(message: unknown) { this.sent.push(message); } });

describe("presence from the shell", () => {
  const never = async () => { throw new Error("must not resolve"); };

  test("the shell's beat is kept, stamped with this process's clock, and answers nothing", async () => {
    delete g.telarDesktopPresence;
    const wire = recorder();
    await handleDesktopMessage({ type: DESKTOP_PRESENCE, active: true, viewingPath: "/main", at: 1 }, never, wire, undefined, 5000);
    expect<Presence | undefined>(g.telarDesktopPresence).toEqual({ active: true, viewingPath: "/main", at: 5000 });
    await handleDesktopMessage({ type: DESKTOP_PRESENCE, active: false, viewingPath: null }, never, wire, undefined, 6000);
    expect<Presence | undefined>(g.telarDesktopPresence).toEqual({ active: false, viewingPath: null, at: 6000 });
    expect(wire.sent).toEqual([]);
  });

  test("a malformed beat is ignored, so the last good one simply ages out", async () => {
    const before = g.telarDesktopPresence;
    for (const junk of [
      { type: DESKTOP_PRESENCE, active: "yes", viewingPath: null },
      { type: DESKTOP_PRESENCE, active: true, viewingPath: "https://evil.example" },
      { type: DESKTOP_PRESENCE, active: true },
      { type: DESKTOP_PRESENCE, active: true, viewingPath: `/${"x".repeat(1024)}` },
    ]) await handleDesktopMessage(junk, never, recorder(), undefined, 9000);
    expect(g.telarDesktopPresence).toBe(before);
  });
});

describe("the Mac takes an alert, and the phone's seen still advances", () => {
  const phone: PushRecord = {
    hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: false,
    enabled: true, completions: true, previews: false, mutedSessions: [],
    deviceId: "paired", revision: "r1", updatedAt: 1000, baselined: true, seen: { s1: signalKey(working) }, activitySent: {},
  };
  const reset = (presence?: Presence) => {
    g.telarDesktopNotify = { seen: { s1: signalKey(working) }, baselined: true, offered: {} };
    g.telarDesktopTook = {};
    delete g.telarConnectedMacs;
    if (presence) g.telarDesktopPresence = presence; else delete g.telarDesktopPresence;
  };
  const phoneSends = () => {
    const sent: Delivery[] = [];
    return { sent, send: async (delivery: Delivery): Promise<DeliveryResult> => { sent.push(delivery); return { status: 200 }; } };
  };
  const moved = new Set(["s1"]);

  test("active on the Mac: a banner, no push, and the record moves on as if it had pushed", async () => {
    reset({ active: true, viewingPath: null, at: 10_000 });
    const mac = recorder();
    notifyDesktop([blocked], moved, { channel: mac, notifyOn: "mac", now: 11_000 });
    expect(mac.sent).toHaveLength(1);
    const push = phoneSends();
    const next = await deliverRecord(phone, [blocked], push.send, 11, { changed: moved, macTook: macTookAlert });
    expect(push.sent).toEqual([]);
    expect(next?.seen.s1).toBe(signalKey(blocked));
    delete g.telarDesktopPresence;
    const later = phoneSends();
    await deliverRecord(next!, [blocked], later.send, 100, { macTook: macTookAlert });
    expect(later.sent).toEqual([]);
  });

  test("viewing the session: neither device, and the phone still moves on", async () => {
    reset({ active: true, viewingPath: "/projects/p1/sessions/s1", at: 10_000 });
    const mac = recorder();
    notifyDesktop([blocked], moved, { channel: mac, notifyOn: "both", now: 11_000 });
    const push = phoneSends();
    const next = await deliverRecord(phone, [blocked], push.send, 11, { changed: moved, macTook: macTookAlert });
    expect([mac.sent, push.sent]).toEqual([[], []]);
    expect(next?.seen.s1).toBe(signalKey(blocked));
  });

  test("idle or unfocused, a beat gone stale, or no shell at all: no banner, and the phone is pushed", async () => {
    for (const presence of [{ active: false, viewingPath: null, at: 10_000 }, { active: true, viewingPath: null, at: 11_000 - PRESENCE_STALE_MS - 1 }, undefined]) {
      reset(presence);
      const mac = recorder();
      notifyDesktop([blocked], moved, { channel: mac, notifyOn: "mac", now: 11_000 });
      expect(mac.sent).toEqual([]);
      const push = phoneSends();
      await deliverRecord(phone, [blocked], push.send, 11, { changed: moved, macTook: macTookAlert });
      expect(push.sent).toHaveLength(1);
    }
  });

  test("a paired Mac in use takes the alert from the phone, until it goes idle or quiet", async () => {
    const report = async (active: boolean) => {
      const { route, params } = matchRoute(pushRoutes({ client: () => ({}) as EngineClient, pairedDevices: () => [] }), "PUT", "/v2/push/desktop/presence/device_mac")!;
      return route.handle({ body: { active }, params, query: new URLSearchParams() } as never);
    };
    for (const [active, at, pushed] of [[true, 10_000, 0], [false, 10_000, 1], [true, 11_000 - PRESENCE_STALE_MS - 1, 1]] as const) {
      reset();
      noteConnectedMac("device_mac", active, at);
      notifyDesktop([blocked], moved, { channel: recorder(), notifyOn: "mac", now: 11_000 });
      const push = phoneSends();
      await deliverRecord(phone, [blocked], push.send, 11, { changed: moved, macTook: macTookAlert });
      expect(push.sent).toHaveLength(pushed);
    }
    reset({ active: true, viewingPath: null, at: Date.now() });
    expect(await report(true)).toMatchObject({ status: 200, body: { hostInUse: true } });
    expect(g.telarConnectedMacs?.device_mac).toBeNumber();
    delete g.telarDesktopPresence;
    expect(await report(false)).toMatchObject({ status: 200, body: { hostInUse: false } });
    expect(g.telarConnectedMacs).toEqual({});
  });

  test("the claim is for that signal only: the next transition asks again", () => {
    reset({ active: true, viewingPath: null, at: 10_000 });
    notifyDesktop([blocked], moved, { channel: recorder(), notifyOn: "mac", now: 11_000 });
    expect(macTookAlert(blocked)).toBe(true);
    expect(macTookAlert(finished)).toBe(false);
    g.telarDesktopPresence = { active: false, viewingPath: null, at: 12_000 };
    notifyDesktop([finished], moved, { channel: recorder(), notifyOn: "mac", now: 12_500 });
    expect(g.telarDesktopTook).toEqual({});
  });

  test("a transition the Mac never raised (its launch baseline) is never claimed", async () => {
    delete g.telarDesktopNotify;
    g.telarDesktopTook = {};
    g.telarDesktopPresence = { active: true, viewingPath: null, at: 10_000 };
    notifyDesktop([blocked], undefined, { channel: recorder(), notifyOn: "mac", now: 11_000 });
    const push = phoneSends();
    await deliverRecord(phone, [blocked], push.send, 11, { macTook: macTookAlert });
    expect(push.sent).toHaveLength(1);
  });

  test("Live Activities are not arbitrated: the host card is still refreshed", async () => {
    reset({ active: true, viewingPath: null, at: 10_000 });
    notifyDesktop([blocked], moved, { channel: recorder(), notifyOn: "mac", now: 11_000 });
    const push = phoneSends();
    const following = { ...phone, liveActivities: true, card: { token: "b".repeat(64), startedAt: 1 } };
    await deliverRecord(following, [blocked], push.send, 11, { changed: moved, macTook: macTookAlert });
    expect(push.sent.map((d) => d.kind)).toEqual(["liveactivity"]);
  });
});

describe("the sound a banner plays", () => {
  const reset = () => {
    g.telarDesktopNotify = { seen: { s1: signalKey(working) }, baselined: true, offered: {} };
    g.telarDesktopPresence = { active: true, viewingPath: null, at: 10_000 };
  };

  test("each alert kind names its own sound in the chosen set", () => {
    const heard = (session: SessionSignal) => {
      reset();
      const mac = recorder();
      notifyDesktop([session], new Set(["s1"]), { channel: mac, notifyOn: "mac", sounds: "felt", now: 11_000 });
      return (mac.sent[0] as { sound?: string }).sound;
    };
    expect([heard(blocked), heard(finished), heard(failed)]).toEqual(["telar-felt-needs", "telar-felt-done", "telar-felt-error"]);
  });

  test("Off sends a banner with no sound at all", () => {
    reset();
    const mac = recorder();
    notifyDesktop([blocked], new Set(["s1"]), { channel: mac, notifyOn: "mac", sounds: "off", now: 11_000 });
    expect(mac.sent).toHaveLength(1);
    expect(mac.sent[0]).not.toHaveProperty("sound");
    expect(soundFor("off", "failed")).toBeUndefined();
  });

  test("defaults to Hilo; a write reads back and nonsense reads as the default", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "telar-sounds-"));
    try {
      const file = path.join(dir, "remote", "notification-sounds.json");
      expect(readSounds(file)).toBe("hilo");
      writeSounds("armonico", file);
      expect(readSounds(file)).toBe("armonico");
      writeFileSync(file, JSON.stringify({ sounds: "kazoo" }));
      expect(readSounds(file)).toBe("hilo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("where Notify on is kept", () => {
  test("a missing, garbled or unknown file reads as the default; a write reads back", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "telar-notify-on-"));
    try {
      const file = path.join(dir, "remote", "notify-on.json");
      expect(readNotifyOn(file)).toBe("mac");
      writeNotifyOn("iphone", file);
      expect(readNotifyOn(file)).toBe("iphone");
      writeFileSync(file, "{not json");
      expect(readNotifyOn(file)).toBe("mac");
      writeFileSync(file, JSON.stringify({ notifyOn: "watch" }));
      expect(readNotifyOn(file)).toBe("mac");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("read elsewhere takes the Mac's banner down", () => {
  test("a read sends the shell a dismiss for that session, ids only, and only when the shell is there", () => {
    const sent: unknown[] = [];
    const wire = { connected: false, send: (message: unknown) => { sent.push(message); } };
    dismissDesktop("s1", wire);
    expect(sent).toEqual([]);
    wire.connected = true;
    dismissDesktop("x".repeat(300), wire);
    expect(sent).toEqual([]);
    dismissDesktop("s1", wire);
    expect(sent).toEqual([{ type: DESKTOP_DISMISS, sessionId: "s1" }]);
  });
});
