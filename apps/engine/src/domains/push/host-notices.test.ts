import { describe, expect, test } from "bun:test";
import type { LiveSessionRow, NotifyOn } from "@telar/engine-client";
import { DESKTOP_NOTICE, PRESENCE_STALE_MS, type Presence } from "./desktop";
import { hostPath, pollHost, showsHere, type HostWatch, type PairedHost } from "./host-notices";

const NOW = 1_000_000;
const host: PairedHost = { id: "host_studio", baseUrl: "http://studio.local:4100", deviceToken: "tlr_device" };
const path = "/hosts/host_studio/projects/p1/sessions/s1";
const here: Presence = { active: true, viewingPath: null, at: NOW };

describe("whether a host's alert shows on this Mac", () => {
  const cases: [string, NotifyOn, Presence | undefined, boolean, boolean][] = [
    ["someone is using this Mac and the host is idle", "mac", here, false, true],
    ["the host's own Mac is in use", "mac", here, true, false],
    ["this Mac is focused on that session", "mac", { ...here, viewingPath: path }, false, false],
    ["nobody is using this Mac", "mac", undefined, false, false],
    ["this Mac's presence went stale", "mac", { ...here, at: NOW - PRESENCE_STALE_MS - 1 }, false, false],
    ["alerts go to the iPhone only", "iphone", here, false, false],
    ["alerts go to both, even with nobody here", "both", undefined, false, true],
    ["alerts go to both but the host is in use", "both", here, true, false],
  ];
  for (const [when, notifyOn, presence, hostInUse, shows] of cases) {
    test(`${shows ? "shows" : "stays quiet"} when ${when}`, () => {
      expect(showsHere(notifyOn, presence, hostInUse, path, NOW)).toBe(shows);
    });
  }

  test("a host session opens under that host's route", () => {
    expect(hostPath("host_studio", "/projects/p1/sessions/s1")).toBe(path);
    expect(hostPath("host_studio", "/main")).toBe("/");
  });
});

function row(activity: LiveSessionRow["activity"], extra: Partial<LiveSessionRow> = {}): LiveSessionRow {
  return { id: "s1", title: "Fix the login", projectId: "p1", activity, activityAt: activity === "working" ? 1 : 2, ...extra } as LiveSessionRow;
}

function fakeHost(state: { sessions: LiveSessionRow[]; hostInUse: boolean; reported: unknown[] }) {
  const fetcher = (async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tlr_device");
    if (url === `${host.baseUrl}/api/mobile/presence`) {
      state.reported.push(JSON.parse(String(init?.body)));
      return Response.json({ hostInUse: state.hostInUse });
    }
    if (url === `${host.baseUrl}/api/sessions/live?all=1`) return Response.json({ sessions: state.sessions, assignments: {}, projects: [] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const sent: Record<string, unknown>[] = [];
  const channel = { connected: true, send: (message: unknown) => sent.push(message as Record<string, unknown>) };
  return { fetcher, sent, channel };
}

describe("a paired host's sessions reach this Mac's desktop", () => {
  test("a host session that needs you posts a notice that opens it here, with this Mac's sounds", async () => {
    const state = { sessions: [row("working")], hostInUse: false, reported: [] as unknown[] };
    const { fetcher, sent, channel } = fakeHost(state);
    const watch: HostWatch = { states: new Map(), etags: new Map() };
    const poll = () => pollHost(host, watch, { fetcher, channel, notifyOn: "mac", sounds: "felt", here, now: NOW });

    await poll();
    expect(sent).toEqual([]);
    state.sessions = [row("blocked")];
    await poll();
    expect(sent).toEqual([{ type: DESKTOP_NOTICE, kind: "blocked", sessionId: "s1", title: "Fix the login", body: expect.any(String), path, sound: "telar-felt-needs" }]);
  });

  test("a finished or failed host session posts too", async () => {
    const state = { sessions: [row("working", { lastTurnOrigin: "user" })], hostInUse: false, reported: [] as unknown[] };
    const { fetcher, sent, channel } = fakeHost(state);
    const watch: HostWatch = { states: new Map(), etags: new Map() };
    const poll = () => pollHost(host, watch, { fetcher, channel, notifyOn: "mac", sounds: "hilo", here, now: NOW });
    await poll();
    state.sessions = [row("idle", { lastTurnOrigin: "user", lastTurnEndedAt: 5, lastTurnFailed: true })];
    await poll();
    expect(sent.map((n) => [n.kind, n.sound])).toEqual([["failed", "telar-hilo-error"]]);
  });

  test("nothing posts here while the host's own Mac is in use", async () => {
    const state = { sessions: [row("working")], hostInUse: true, reported: [] as unknown[] };
    const { fetcher, sent, channel } = fakeHost(state);
    const watch: HostWatch = { states: new Map(), etags: new Map() };
    await pollHost(host, watch, { fetcher, channel, notifyOn: "mac", sounds: "felt", here, now: NOW });
    state.sessions = [row("blocked")];
    await pollHost(host, watch, { fetcher, channel, notifyOn: "mac", sounds: "felt", here, now: NOW });
    expect(sent).toEqual([]);
  });

  test("this Mac tells the host whether someone is using it", async () => {
    const state = { sessions: [], hostInUse: false, reported: [] as unknown[] };
    const { fetcher, channel } = fakeHost(state);
    const poll = (notifyOn: NotifyOn, presence?: Presence) => pollHost(host, { states: new Map(), etags: new Map() }, { fetcher, channel, notifyOn, here: presence, now: NOW });
    await poll("mac", here);
    await poll("mac", { ...here, active: false });
    await poll("iphone", here);
    expect(state.reported).toEqual([{ active: true }, { active: false }, { active: false }]);
  });

  test("a host that cannot be reached posts nothing", async () => {
    const sent: unknown[] = [];
    const fetcher = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await pollHost(host, { states: new Map(), etags: new Map() }, { fetcher, channel: { connected: true, send: (m) => sent.push(m) }, now: NOW });
    expect(sent).toEqual([]);
  });
});
