import { expect, test } from "bun:test";
import { startEngine } from "../../daemon";
import { stubModels } from "../../../test/stub-models";
import { useTempStores } from "../../../test/temp-store";

const { root, readyStore } = useTempStores();

test("the live-session read carries the arrangement, so a drag on one device reaches the others", () => {
  // Every rail already polls this route, so the layout riding it reaches other devices with no new request.
  const { store } = readyStore();
  expect(store.live.all().layout).toEqual({ projectOrder: [], sessionOrder: {}, pinnedOrder: [], mode: "grouped" });

  store.settings.setSidebarLayout({ projectOrder: ["p2", "p1"] });
  store.settings.setSidebarLayout({ sessionOrder: { p1: ["s2", "s1"] } });
  store.settings.setSidebarLayout({ pinnedOrder: ["s9"] });
  expect(store.live.all().layout).toEqual({
    projectOrder: ["p2", "p1"],
    sessionOrder: { p1: ["s2", "s1"] },
    pinnedOrder: ["s9"],
    mode: "grouped",
  });
});

function shelfStore() {
  const { store } = readyStore();
  for (const id of ["session_two", "session_three"]) {
    store.lifecycle.createSession({ id, projectId: "project_one", title: id });
    store.lifecycle.updateSession(id, { settledOverride: "settled" });
  }
  return store;
}

const ids = (rows: { sessions: { id: string }[] }) => rows.sessions.map((session) => session.id).sort();

test("the shelf read answers the settled rows alone, and `all` is the list and the shelf together", () => {
  const store = shelfStore();
  expect(ids(store.live.rows({ shelf: true }))).toEqual(["session_three", "session_two"]);
  expect(ids(store.live.rows())).toEqual(["session_one"]);
  expect(ids(store.live.rows({ all: true }))).toEqual(["session_one", "session_three", "session_two"]);
  expect(store.live.rows({ shelf: true }).settledCount).toBe(2);
});

test("work on an open session leaves the shelf's revision alone; a change to the shelf moves it", () => {
  const store = shelfStore();
  const shelf = store.live.revision({ shelf: true });
  store.intake.submitTurn("session_one", { runId: "run_one", input: "hello" });
  expect(store.live.revision({ shelf: true })).toBe(shelf);
  expect(store.live.revision({ all: true })).toBeGreaterThan(shelf);

  store.lifecycle.updateSession("session_two", { title: "Renamed while settled" });
  expect(store.live.revision({ shelf: true })).toBeGreaterThan(shelf);
});

test("a settled row read twice still shows what changed on it in between", () => {
  const store = shelfStore();
  expect(store.live.rows({ shelf: true }).sessions.find((row) => row.id === "session_two")?.title).toBe("session_two");
  store.lifecycle.updateSession("session_two", { title: "Renamed while settled" });
  expect(store.live.rows({ shelf: true }).sessions.find((row) => row.id === "session_two")?.title).toBe("Renamed while settled");

  store.lifecycle.updateSession("session_two", { settledOverride: "active" });
  expect(ids(store.live.rows({ shelf: true }))).toEqual(["session_three"]);
  store.lifecycle.updateSession("session_two", { settledOverride: "settled" });
  expect(ids(store.live.rows({ shelf: true }))).toEqual(["session_three", "session_two"]);
});

test("an unchanged shelf is a 304, even while another session works", async () => {
  const engineRoot = root();
  const daemon = await startEngine({ models: stubModels, engineRoot });
  const url = `http://127.0.0.1:${daemon.discovery.port}/v2/sessions/live?shelf=1`;
  const read = (etag?: string) =>
    fetch(url, { headers: { authorization: `Bearer ${daemon.discovery.token}`, ...(etag ? { "if-none-match": etag } : {}) } });
  const send = (method: string, path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${daemon.discovery.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemon.discovery.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await send("POST", "/v2/projects", { id: "project_one", name: "One", root: engineRoot });
    await send("POST", "/v2/sessions", { id: "session_open", projectId: "project_one" });
    await send("POST", "/v2/sessions", { id: "session_done", projectId: "project_one" });
    await send("PATCH", "/v2/sessions/session_done", { settledOverride: "settled" });

    const first = await read();
    const etag = first.headers.get("etag")!;
    expect(((await first.json()) as { sessions: { id: string }[] }).sessions.map((row) => row.id)).toEqual(["session_done"]);

    await send("PATCH", "/v2/sessions/session_open", { title: "Busy elsewhere" });
    const unchanged = await read(etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    await send("PATCH", "/v2/sessions/session_open", { settledOverride: "settled" });
    const moved = await read(etag);
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { sessions: { id: string }[] }).sessions.map((row) => row.id).sort()).toEqual(["session_done", "session_open"]);
  } finally {
    await daemon.close();
  }
});
