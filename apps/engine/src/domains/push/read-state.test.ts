import { describe, expect, test } from "bun:test";
import { EngineClientError, type EngineClient } from "@telar/engine-client";
import { matchRoute } from "../../platform/http/router";
import { createDesktopStream, DESKTOP_DISMISS, dismissDesktop } from "./desktop";
import { clearedSessions, parseReadStateIds, READ_STATE_MAX } from "./read-sync";
import { pushRoutes } from "./routes";

const sessions: Record<string, { activity: string; lastTurnSequence?: number; lastReadTurnSequence?: number }> = {
  read: { activity: "idle", lastTurnSequence: 3, lastReadTurnSequence: 3 },
  unread: { activity: "idle", lastTurnSequence: 3, lastReadTurnSequence: 2 },
  waiting: { activity: "blocked", lastTurnSequence: 3, lastReadTurnSequence: 3 },
};

function readState(ids: string) {
  const client = {
    async session(id: string) {
      if (id === "gone") throw new EngineClientError("not_found", "no such session", 404);
      if (id === "broken") throw new Error("engine away");
      return { session: sessions[id] };
    },
  } as unknown as EngineClient;
  const routes = pushRoutes({ client: () => client, pairedDevices: () => [] });
  const { route, params } = matchRoute(routes, "GET", "/v2/push/read-state")!;
  return route.handle({ body: {}, params, query: new URLSearchParams({ ids }) });
}

describe("the reconcile route", () => {
  test("bounds what it is asked", async () => {
    expect((await readState("")).status).toBe(400);
    expect((await readState("a,b/c")).status).toBe(400);
    expect((await readState(Array.from({ length: READ_STATE_MAX + 1 }, (_, n) => `s${n}`).join(","))).status).toBe(400);
  });
  test("answers with what the engine says is read or gone", async () => {
    expect(await readState("read,unread,waiting,gone,broken")).toEqual({ status: 200, body: { cleared: ["read", "gone"] } });
  });
  test("ids parse to a bounded, de-duplicated list of engine ids", () => {
    expect(parseReadStateIds("a,b,a,,c_1-x")).toEqual(["a", "b", "c_1-x"]);
    expect(parseReadStateIds(null)).toBeUndefined();
    expect(parseReadStateIds("a:b")).toBeUndefined();
  });
  test("answers with the engine's read state: read, gone, never blocked, and keeps what it could not read", async () => {
    const cleared = await clearedSessions(["read", "unread", "waiting", "gone", "broken"], async id => {
      if (id === "broken") throw new Error("engine away");
      return sessions[id];
    });
    expect(cleared).toEqual(["read", "gone"]);
  });
});

describe("the desktop hook", () => {
  test("a read dismisses the Mac's notice for every connected shell, and nothing once they leave", () => {
    const stream = createDesktopStream();
    const heard: string[] = [];
    const stop = stream.subscribe({ write: (chunk) => heard.push(chunk) });
    dismissDesktop("s1", stream);
    stop();
    dismissDesktop("s2", stream);
    expect(heard.map((chunk) => JSON.parse(chunk.replace(/^data: /, "")))).toEqual([{ type: DESKTOP_DISMISS, sessionId: "s1" }]);
  });
});
