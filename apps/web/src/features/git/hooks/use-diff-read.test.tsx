import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TurnState } from "@telar/engine-client";
import { useDiffRead, useDiffRefresh } from "./use-diff-read";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  jest.useRealTimers();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function Refresher({ load, active }: { load: () => Promise<void>; active?: TurnState }) {
  useDiffRefresh(load, active);
  return null;
}

test("a slow diff read is never stacked by the timer", async () => {
  let calls = 0;
  let finish = () => {};
  const load = () => {
    calls += 1;
    return new Promise<void>((resolve) => (finish = resolve));
  };
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Refresher load={load} />));
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(calls).toBe(1);
  await act(async () => finish());
  await act(async () => jest.advanceTimersByTime(15_000));
  expect(calls).toBe(2);
});

test("a turn changing state re-reads at once", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
  };
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Refresher load={load} active="running" />));
  act(() => root!.render(<Refresher load={load} active="completed" />));
  expect(calls).toBe(2);
});

test("a folder whose status answers 304 is not diffed again", async () => {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const tag = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
    asked.push(tag ? `${url} ${tag}` : String(url));
    if (String(url).endsWith("/git/status")) {
      return tag === '"t1"' ? new Response(null, { status: 304, headers: { etag: '"t1"' } }) : Response.json({ dirtyFiles: 1 }, { headers: { etag: '"t1"' } });
    }
    return Response.json({ diff: { files: [] } });
  }) as typeof fetch;
  const loads: Array<() => Promise<void>> = [];
  function Reader({ onLoad }: { onLoad: (load: () => Promise<void>) => void }) {
    const { load } = useDiffRead("session_1", "p1", undefined);
    useEffect(() => onLoad(load), [load, onLoad]);
    return null;
  }
  try {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Reader onLoad={(load) => void loads.push(load)} />));
    await act(() => loads[0]!());
    await act(() => loads[0]!());
    expect(asked).toEqual(["/api/sessions/session_1/git/status", "/api/sessions/session_1/diff", '/api/sessions/session_1/git/status "t1"']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
