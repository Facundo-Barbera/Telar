import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_INBOX_POLICY, EngineClient } from "@telar/engine-client";
import { GET as liveGet } from "@/app/api/sessions/live/route";
import { click, installTestDom } from "@/test/dom";
import { liveReads, liveRow, mountRail, nextPass, project, stubRail, type LiveAnswer, type RailRequest } from "@/test/rail";
import { startEngine, type EngineDaemon } from "../../../../../engine/src/daemon";

installTestDom();

const page = (extra: Record<string, unknown> = {}) => ({ projects: [project("p1", "One")], sessions: [liveRow("a")], ...extra });
const mini = { id: "mini", name: "Mini" };
const shelfButton = (host: HTMLElement) => [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Settled"));

describe("a rail's pass is one read per host", () => {
  test("each pass asks for the host book and one live list per Mac, nothing beside them", async () => {
    const requests = stubRail(() => ({ body: page() }), [mini]);
    await mountRail();
    const before = requests.length;
    await nextPass();
    expect(requests.slice(before).map((request) => request.path).sort()).toEqual(["/api/hosts", "/api/hosts/mini/sessions/live", "/api/sessions/live"]);
  });

  test("the settling window rides the list and bands that Mac's rows", async () => {
    const old = [liveRow("old", { idleHours: 2 })];
    stubRail(() => ({ body: page({ sessions: old, inbox: { ...DEFAULT_INBOX_POLICY, autoSettleAfterHours: 1 } }) }));
    const host = await mountRail();
    expect(host.querySelector("#sidebar-session-results")!.textContent).not.toContain("Title old");
    expect(shelfButton(host)?.textContent).toContain("1");
  });

  test("without a window on the list the default one applies, and the row stays in the list", async () => {
    stubRail(() => ({ body: page({ sessions: [liveRow("old", { idleHours: 2 })] }) }));
    const host = await mountRail();
    expect(host.querySelector("#sidebar-session-results")!.textContent).toContain("Title old");
  });

  test("two addresses onto one engine draw its rows once, going by the daemon id on the list", async () => {
    stubRail(() => ({ body: page({ daemonId: "engine-1" }) }), [mini]);
    const same = await mountRail();
    expect(same.textContent!.split("Title a").length - 1).toBe(1);
  });

  test("with no daemon id, nothing is folded", async () => {
    stubRail(() => ({ body: page() }), [mini]);
    const host = await mountRail();
    expect(host.textContent!.split("Title a").length - 1).toBe(2);
  });
});

describe("and that one read is conditional", () => {
  test("the rail asks with the tag it was given, and keeps its rows on a 304", async () => {
    const requests = stubRail((request) => (request.ifNoneMatch === "tag-1" ? { status: 304, etag: "tag-1" } : { etag: "tag-1", body: page() }));
    const host = await mountRail();
    expect(liveReads(requests)[0]!.ifNoneMatch).toBeUndefined();
    await nextPass();
    const reads = liveReads(requests);
    expect(reads).toHaveLength(2);
    expect(reads[1]!.ifNoneMatch).toBe("tag-1");
    expect(host.textContent).toContain("Title a");
  });

  test("a Mac that mints no tag is asked with its revision cursor, and unchanged keeps the rows", async () => {
    const requests = stubRail((request) =>
      request.search === "?since=7" ? { body: { unchanged: true, revision: 7 } } : { body: page({ revision: 7 }) },
    );
    const host = await mountRail();
    await nextPass();
    expect(liveReads(requests).map((request) => request.search)).toEqual(["", "?since=7"]);
    expect(host.textContent).toContain("Title a");
  });

  test("with neither a tag nor a revision, every pass is a full read", async () => {
    const requests = stubRail(() => ({ body: page() }));
    await mountRail();
    await nextPass();
    expect(liveReads(requests).map(({ search, ifNoneMatch }) => ({ search, ifNoneMatch }))).toEqual([
      { search: "", ifNoneMatch: undefined },
      { search: "", ifNoneMatch: undefined },
    ]);
  });

  test("each Mac's tag goes back to that Mac only", async () => {
    const answer = (request: RailRequest): LiveAnswer => ({ etag: request.path.includes("/hosts/mini/") ? "mini-tag" : "local-tag", body: page() });
    const requests = stubRail(answer, [mini]);
    await mountRail();
    await nextPass();
    const second = liveReads(requests).slice(2);
    expect(second.find((request) => request.path === "/api/sessions/live")!.ifNoneMatch).toBe("local-tag");
    expect(second.find((request) => request.path === "/api/hosts/mini/sessions/live")!.ifNoneMatch).toBe("mini-tag");
  });

  test("opening the Settled shelf asks for the whole list rather than spending the cursor", async () => {
    const requests = stubRail((request) => (request.search === "?all=1"
      ? { body: page({ sessions: [liveRow("a"), liveRow("done", { settledOverride: "settled" })], revision: 7 }) }
      : { body: page({ revision: 7, settledCount: 1 }) }));
    const host = await mountRail();
    await click(shelfButton(host));
    expect(liveReads(requests).at(-1)!.search).toBe("?all=1");
    expect(host.textContent).toContain("Title done");
  });
});

describe("the route forwards what the engine stamped", () => {
  const saved = { home: process.env.TELAR_HOME, cockpit: process.env.TELAR_COCKPIT };
  let root: string;
  let daemon: EngineDaemon;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-live-route-"));
    process.env.TELAR_HOME = root;
    process.env.TELAR_COCKPIT = "1";
    daemon = await startEngine({ engineRoot: path.join(root, "engine") });
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_one", name: "One", root });
    await client.createSession({ id: "session_open", projectId: "project_one" });
    await client.createSession({ id: "session_done", projectId: "project_one" });
    await client.settleSession("session_done", true);
  });

  afterAll(async () => {
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of [["TELAR_HOME", saved.home], ["TELAR_COCKPIT", saved.cockpit]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const read = (query = "", headers: Record<string, string> = {}) => liveGet(new Request(`http://cockpit.test/api/sessions/live${query}`, { headers }));

  test("the engine's identity and settling window reach a browser", async () => {
    const body = await (await read()).json();
    expect(typeof body.daemonId).toBe("string");
    expect(body.inbox).toMatchObject({ autoSettleAfterHours: DEFAULT_INBOX_POLICY.autoSettleAfterHours });
  });

  test("the default read leaves the shelf out and counts it; ?all=1 brings it", async () => {
    const narrow = await (await read()).json();
    expect(narrow.sessions.map((session: { id: string }) => session.id)).toEqual(["session_open"]);
    expect(narrow.settledCount).toBe(1);
    const wide = await (await read("?all=1")).json();
    expect(wide.sessions.map((session: { id: string }) => session.id).sort()).toEqual(["session_done", "session_open"]);
  });

  test("the first read carries a tag out, and handing it back is answered 304", async () => {
    const first = await read();
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await read("", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
  });

  test("a narrow tag is not spent against the whole list", async () => {
    const etag = (await read()).headers.get("etag")!;
    const wide = await read("?all=1", { "if-none-match": etag });
    expect(wide.status).toBe(200);
  });

  test("the revision cursor still answers a caller that sends one and no tag", async () => {
    const { revision } = await (await read()).json();
    expect(await (await read(`?since=${revision}`)).json()).toMatchObject({ unchanged: true, revision });
  });
});
