import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AUTOMATIC_ACTIVITY, CARD_LINGER_S, type MobileRegistration } from "./push";
import { ACTIVITY_STALE_S, BARE_END_DISMISS_S, END_DISMISS_S, automaticActivityDelivery } from "./card";
import { v2Body } from "./relay-v2";

const swift = readFileSync(new URL("../../../../ios/Shared/SessionActivityAttributes.swift", import.meta.url), "utf8");
function fields(body: string) {
  const all = [...body.matchAll(/var (\w+): ([\w?[\]]+)(?: = [^\n]+)?\n/g)].filter(m => !body.slice(0, m.index).includes("{ url(")).map(m => ({ name: m[1], optional: m[2].endsWith("?") }));
  return { all: all.map(f => f.name).sort(), required: all.filter(f => !f.optional).map(f => f.name).sort() };
}
const stateBody = swift.slice(swift.indexOf("struct ContentState"), swift.indexOf("}", swift.indexOf("struct ContentState")));
const attributesBody = swift.slice(swift.indexOf("}", swift.indexOf("struct ContentState")) + 1, swift.indexOf("var sessionURL"));
const contentState = fields(stateBody), attributes = fields(attributesBody);

const record: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", hostName: "Studio", token: "a".repeat(64), topic: "io.github.novarix.telar", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [], liveActivities: true, pushToStartToken: "b".repeat(64),
};
const now = 1_800_000_100.5;
const working = { id: "session_1", title: "Deploy", activity: "working" };
const REFERENCE_EPOCH = 978_307_200;

function expectDecodable(state: Record<string, unknown>) {
  for (const key of Object.keys(state)) expect(contentState.all).toContain(key);
  for (const key of contentState.required) expect(state).toHaveProperty(key);
}

test("the Swift type was read, so the checks below compare against something", () => {
  expect(contentState.required).toEqual(["ended", "startedAt", "status", "title", "updatedAt"]);
  expect(contentState.all).toEqual(["activeCount", "ended", "rows", "sessionId", "startedAt", "status", "title", "updatedAt"]);
  expect(attributes.all).toEqual(["hostId", "hostName", "sessionId"]);
});

describe("the host card", () => {
  test("is a liveactivity push to the bundle's liveactivity topic", () => {
    const delivery = automaticActivityDelivery(record, [working], "c".repeat(64), 1_800_000_000, now);
    expect(delivery.kind).toBe("liveactivity");
    expect(delivery.topic).toBe("io.github.novarix.telar.push-type.liveactivity");
    expect(delivery.token).toBe("c".repeat(64));
    expect(automaticActivityDelivery({ ...record, topic: "io.github.novarix.telar.dev", sandbox: true }, [working], "c".repeat(64), 1, now).topic).toBe("io.github.novarix.telar.dev.push-type.liveactivity");
  });

  test("its content-state decodes as SessionActivityAttributes.ContentState, dates from 2001", () => {
    const aps = automaticActivityDelivery(record, [working], "c".repeat(64), 1_800_000_000, now).payload.aps;
    const state = aps["content-state"] as Record<string, unknown>;
    expectDecodable(state);
    expect(state.updatedAt).toBe(now - REFERENCE_EPOCH);
    expect(state.startedAt).toBe(1_800_000_000 - REFERENCE_EPOCH);
    expect(aps.timestamp).toBe(Math.floor(now));
    expect(aps.event).toBe("update");
    expect(aps["stale-date"]).toBe(Math.floor(now + ACTIVITY_STALE_S));
  });

  test("finished work updates the card in place, and an end dismisses it soon, or later when it has rows to show", () => {
    const finished = automaticActivityDelivery(record, [{ ...working, activity: "idle" }], "c".repeat(64), 1, now).payload.aps;
    expect(finished.event).toBe("update");
    expect(finished["content-state"]).toMatchObject({ status: "Finished", ended: true });
    expect(finished).not.toHaveProperty("dismissal-date");
    expect(finished["stale-date"]).toBe(Math.floor(now + ACTIVITY_STALE_S + CARD_LINGER_S));
    const end = automaticActivityDelivery(record, [], "c".repeat(64), 1, now, "end").payload.aps;
    expect(end["dismissal-date"]).toBe(Math.floor(now + BARE_END_DISMISS_S));
    const done = { ...working, activity: "idle", lastTurnEndedAt: now * 1000 - 1000 };
    expect(automaticActivityDelivery(record, [done], "c".repeat(64), 1, now, "end").payload.aps["dismissal-date"]).toBe(Math.floor(now + END_DISMISS_S));
    expectDecodable(end["content-state"] as Record<string, unknown>);
  });
});

describe("the automatic card", () => {
  test("a start carries everything push-to-start needs, decodable as the Swift type", () => {
    const delivery = automaticActivityDelivery(record, [working], "b".repeat(64), now, now, "start");
    const aps = delivery.payload.aps;
    expect(delivery.topic).toBe("io.github.novarix.telar.push-type.liveactivity");
    expect(aps.event).toBe("start");
    expect(aps["attributes-type"]).toBe("SessionActivityAttributes");
    const attrs = aps.attributes as Record<string, unknown>;
    expect(Object.keys(attrs).sort()).toEqual(attributes.all);
    expect(attrs.sessionId).toBe(AUTOMATIC_ACTIVITY);
    expect(aps.alert).toEqual({ title: "Telar", body: "Agent work in progress" });
    expect(aps["input-push-token"]).toBe(1);
    expectDecodable(aps["content-state"] as Record<string, unknown>);
    expect(delivery.activityId).toBeUndefined();
    expect(v2Body(delivery)).toMatchObject({ kind: "liveactivity", start: true });
  });

  test("an update and an end go to the automatic card itself", () => {
    const update = automaticActivityDelivery(record, [working], "e".repeat(64), now - 50, now);
    expect(update.payload.aps.event).toBe("update");
    expect(update.activityId).toBe(AUTOMATIC_ACTIVITY);
    expect(v2Body(update)).toMatchObject({ kind: "liveactivity", activity: AUTOMATIC_ACTIVITY });
    expectDecodable(update.payload.aps["content-state"] as Record<string, unknown>);
    const end = automaticActivityDelivery(record, [], "e".repeat(64), now - 50, now, "end");
    expect(end.payload.aps.event).toBe("end");
    expectDecodable(end.payload.aps["content-state"] as Record<string, unknown>);
    expect(JSON.parse(JSON.stringify(end.payload.aps["content-state"]))).not.toHaveProperty("sessionId");
  });
});
