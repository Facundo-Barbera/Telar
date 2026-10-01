import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TurnState } from "@telar/engine-client";
import { useDiffRefresh } from "./use-diff-read";

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
