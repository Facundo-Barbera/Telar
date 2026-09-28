import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEngine } from "../src/daemon";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("close clears every interval the engine started", async () => {
  const live = new Set<unknown>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args);
    live.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
    live.delete(timer);
    realClearInterval(timer);
  }) as typeof clearInterval;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-timers-"));
  roots.push(root);
  const daemon = await startEngine({ models: stubModels, engineRoot: root });
  expect(live.size).toBeGreaterThan(0);
  await daemon.close();
  expect(live.size).toBe(0);
});
