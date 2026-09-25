/**
 * THE LIVE ACTIVITY PAYLOADS, AGAINST THE SWIFT TYPE THAT DECODES THEM.
 *
 * APNs answers 200 for a Live Activity push whose `content-state` or
 * `attributes` the phone cannot decode, and the phone then drops it silently.
 * So the only place a key drifting between this file and
 * `apps/ios/Shared/SessionActivityAttributes.swift` can be caught is here:
 * every key sent must be one the Swift type declares, and every key it
 * requires must be sent.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ACTIVITY_STALE_S, AUTOMATIC_ACTIVITY, activityDelivery, automaticActivityDelivery, type MobileRegistration } from "./push";
import { v2Body } from "./relay-v2";

const swift = readFileSync(new URL("../../../ios/Shared/SessionActivityAttributes.swift", import.meta.url), "utf8");
/** `var name: Type` lines of a Swift struct body, split into required and optional. */
function fields(body: string) {
  const all = [...body.matchAll(/var (\w+): ([\w?]+)(?: = [^\n]+)?\n/g)].filter(m => !body.slice(0, m.index).includes("{ url(")).map(m => ({ name: m[1], optional: m[2].endsWith("?") }));
  return { all: all.map(f => f.name).sort(), required: all.filter(f => !f.optional).map(f => f.name).sort() };
}
const stateBody = swift.slice(swift.indexOf("struct ContentState"), swift.indexOf("}", swift.indexOf("struct ContentState")));
const attributesBody = swift.slice(swift.indexOf("}", swift.indexOf("struct ContentState")) + 1, swift.indexOf("var sessionURL"));
const contentState = fields(stateBody), attributes = fields(attributesBody);

const record: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", hostName: "Studio", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [], liveActivities: true, pushToStartToken: "b".repeat(64),
  activities: [{ sessionId: "session_1", token: "c".repeat(64), startedAt: 1_800_000_000 }],
};
const now = 1_800_000_100.5;
const working = { id: "session_1", title: "Deploy", activity: "working" };
const REFERENCE_EPOCH = 978_307_200; // Swift's default Date coding counts from 2001.

function expectDecodable(state: Record<string, unknown>) {
  for (const key of Object.keys(state)) expect(contentState.all).toContain(key);
  for (const key of contentState.required) expect(state).toHaveProperty(key);
}

test("the Swift type was read, so the checks below compare against something", () => {
  expect(contentState.required).toEqual(["ended", "startedAt", "status", "title", "updatedAt"]);
  expect(contentState.all).toEqual(["activeCount", "ended", "sessionId", "startedAt", "status", "title", "updatedAt"]);
  expect(attributes.all).toEqual(["hostId", "hostName", "sessionId"]);
});

describe("a followed session's card", () => {
  test("is a liveactivity push to the bundle's liveactivity topic, named by its session", () => {
    const delivery = activityDelivery(record, record.activities[0], working, now);
    expect(delivery.kind).toBe("liveactivity");
    expect(delivery.topic).toBe("com.telar.mobile.push-type.liveactivity");
    expect(delivery.token).toBe("c".repeat(64));
    expect(delivery.activityId).toBe("session_1");
    expect(activityDelivery({ ...record, topic: "com.telar.mobile.dev", sandbox: true }, record.activities[0], working, now).topic).toBe("com.telar.mobile.dev.push-type.liveactivity");
  });

  test("its content-state decodes as SessionActivityAttributes.ContentState, dates from 2001", () => {
    const aps = activityDelivery(record, record.activities[0], working, now).payload.aps;
    const state = aps["content-state"] as Record<string, unknown>;
    expectDecodable(state);
    expect(state.updatedAt).toBe(now - REFERENCE_EPOCH);
    expect(state.startedAt).toBe(1_800_000_000 - REFERENCE_EPOCH);
    expect(aps.timestamp).toBe(Math.floor(now));
    expect(aps.event).toBe("update");
    expect(aps["stale-date"]).toBe(Math.floor(now + ACTIVITY_STALE_S));
  });

  test("an idle or vanished session ends the card and schedules its dismissal", () => {
    for (const session of [{ ...working, activity: "idle" }, undefined]) {
      const aps = activityDelivery(record, record.activities[0], session, now).payload.aps;
      expect(aps.event).toBe("end");
      expect(aps["dismissal-date"]).toBeGreaterThan(Math.floor(now));
      expectDecodable(aps["content-state"] as Record<string, unknown>);
    }
  });
});

describe("the automatic card", () => {
  test("a start carries everything push-to-start needs, decodable as the Swift type", () => {
    const delivery = automaticActivityDelivery(record, [working], "b".repeat(64), now, now, true);
    const aps = delivery.payload.aps;
    expect(delivery.topic).toBe("com.telar.mobile.push-type.liveactivity");
    expect(aps.event).toBe("start");
    expect(aps["attributes-type"]).toBe("SessionActivityAttributes");
    const attrs = aps.attributes as Record<string, unknown>;
    expect(Object.keys(attrs).sort()).toEqual(attributes.all);
    expect(attrs.sessionId).toBe(AUTOMATIC_ACTIVITY);
    expect(aps.alert).toEqual({ title: "Telar", body: "Agent work in progress" });
    expect(aps["input-push-token"]).toBe(1);
    expectDecodable(aps["content-state"] as Record<string, unknown>);
    // A start goes to the push-to-start token, so it names no activity.
    expect(delivery.activityId).toBeUndefined();
    expect(v2Body(delivery)).toMatchObject({ kind: "liveactivity", start: true });
  });

  test("an update and an end go to the automatic card itself", () => {
    const update = automaticActivityDelivery(record, [working], "e".repeat(64), now - 50, now);
    expect(update.payload.aps.event).toBe("update");
    expect(update.activityId).toBe(AUTOMATIC_ACTIVITY);
    expect(v2Body(update)).toMatchObject({ kind: "liveactivity", activity: AUTOMATIC_ACTIVITY });
    expectDecodable(update.payload.aps["content-state"] as Record<string, unknown>);
    const end = automaticActivityDelivery(record, [], "e".repeat(64), now - 50, now);
    expect(end.payload.aps.event).toBe("end");
    expectDecodable(end.payload.aps["content-state"] as Record<string, unknown>);
    // An undefined field is dropped on the wire, never sent as null.
    expect(JSON.parse(JSON.stringify(end.payload.aps["content-state"]))).not.toHaveProperty("sessionId");
  });
});
