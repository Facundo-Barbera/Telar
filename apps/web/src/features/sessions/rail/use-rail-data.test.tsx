import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useRailData } = await import("./use-rail-data");
const { announceProjectsChanged } = await import("@/features/projects/projects");

const realFetch = globalThis.fetch;
let root: Root | undefined;

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function Rail() {
  const { projects } = useRailData();
  return <p>{projects.map((project) => project.name).join(",") || "No projects yet"}</p>;
}

async function flush() {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("a project added while the rail is mid-read still shows up", async () => {
  const registered: { id: string; name: string }[] = [];
  let firstRead: (() => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/hosts")) return Response.json({ hosts: [] });
    if (url.includes("/api/sessions/live")) {
      const page = Response.json({ projects: [...registered], sessions: [] });
      if (firstRead === undefined) return new Promise<Response>((resolve) => (firstRead = () => resolve(page)));
      return page;
    }
    return Response.json({});
  }) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Rail />));
  await flush();
  expect(firstRead).toBeDefined();

  registered.push({ id: "project_700d", name: "exoplanets" });
  act(() => announceProjectsChanged());
  firstRead!();
  await flush();

  expect(host.textContent).toBe("exoplanets");
});

type Data = ReturnType<typeof useRailData>;

let latest: Data | undefined;

function Shelf() {
  const data = useRailData();
  useEffect(() => {
    latest = data;
  });
  return <p>{data.sessions.map((session) => session.title).join(",")}</p>;
}

const at = Date.now();
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, projectId: "p1", createdAt: at, updatedAt: at, state: "active", driver: "claude", workspace: { mode: "local" }, activity: "idle", ...extra });

function stubShelf() {
  const shelfReads: { ifNoneMatch?: string }[] = [];
  const state = { hold: false, release: [] as (() => void)[] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/hosts")) return Response.json({ hosts: [] });
    const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    if (url.includes("shelf=1")) {
      shelfReads.push(ifNoneMatch ? { ifNoneMatch } : {});
      const answer = () => Response.json({ projects: [], sessions: [row("settled one", { settledOverride: "settled" })] }, { headers: { etag: "shelf-1" } });
      if (!state.hold) return answer();
      return new Promise<Response>((resolve) => state.release.push(() => resolve(answer())));
    }
    if (url.includes("/api/sessions/live") && ifNoneMatch === "lean-1") return new Response(null, { status: 304, headers: { etag: "lean-1" } });
    if (url.includes("/api/sessions/live")) return Response.json({ projects: [], sessions: [row("open one")], settledCount: 1 }, { headers: { etag: "lean-1" } });
    return Response.json({});
  }) as typeof fetch;
  return { shelfReads, state };
}

async function mountShelf() {
  const into = { get current() { return latest; } };
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Shelf />));
  await flush();
  return { host, into };
}

test("a shelf read before shows the moment it is reopened, while the engine is still being asked", async () => {
  window.localStorage.clear();
  const { shelfReads, state } = stubShelf();
  const { host, into } = await mountShelf();
  act(() => into.current!.toggleSettled());
  await flush();
  act(() => into.current!.toggleSettled());
  state.hold = true;
  act(() => into.current!.toggleSettled());
  expect(host.textContent).toContain("settled one");
  await flush();
  expect(shelfReads.at(-1)).toEqual({ ifNoneMatch: "shelf-1" });
  state.release.forEach((release) => release());
  await flush();
});

test("the last launch's shelf shows before the first read of this one answers", async () => {
  window.localStorage.clear();
  window.localStorage.setItem("telar-settled-cache", JSON.stringify({ local: { etag: "shelf-1", sessions: [{ ...row("kept from before"), settledOverride: "settled" }] } }));
  const { shelfReads, state } = stubShelf();
  state.hold = true;
  const { host, into } = await mountShelf();
  act(() => into.current!.toggleSettled());
  expect(host.textContent).toContain("kept from before");
  await flush();
  expect(shelfReads).toEqual([{ ifNoneMatch: "shelf-1" }]);
  state.release.forEach((release) => release());
  await flush();
});

test("a row change makes the next pass read the shelf again", async () => {
  window.localStorage.clear();
  const { shelfReads } = stubShelf();
  const { into } = await mountShelf();
  act(() => into.current!.toggleSettled());
  await flush();
  await act(async () => into.current!.loadAll());
  expect(shelfReads).toHaveLength(1);
  act(() => into.current!.onRowChanged({ removed: "settled one" }));
  await act(async () => into.current!.loadAll());
  expect(shelfReads).toHaveLength(2);
});
