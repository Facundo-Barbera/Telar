// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import type { TaskOutputPage } from "@telar/engine-client";
import { drainTaskOutput } from "./task-log";

const page = (over: Partial<TaskOutputPage>): TaskOutputPage => ({ text: "", cursor: 0, size: 0, truncated: false, more: false, missing: false, ...over });

test("pages are read back to back while the engine says there is more", async () => {
  const asked: Array<number | undefined> = [];
  const pages = [page({ text: "a", cursor: 1, more: true }), page({ text: "b", cursor: 2 })];
  const written: string[] = [];
  const drained = await drainTaskOutput(
    async (after) => {
      asked.push(after);
      return pages.shift()!;
    },
    undefined,
    (one) => written.push(one.text),
  );
  expect(asked).toEqual([undefined, 1]);
  expect(written).toEqual(["a", "b"]);
  expect(drained).toEqual({ cursor: 2, missing: false, wrote: true });
});

test("a page that does not continue the last one restarts the screen", async () => {
  const restarts: boolean[] = [];
  await drainTaskOutput(async () => page({ text: "new", cursor: 3 }), 40, (_, restart) => restarts.push(restart));
  expect(restarts).toEqual([true]);
});

test("a missing log keeps the cursor and writes nothing", async () => {
  let wrote = false;
  const drained = await drainTaskOutput(async () => page({ missing: true }), 12, () => (wrote = true));
  expect(drained).toEqual({ cursor: 12, missing: true, wrote: false });
  expect(wrote).toBe(false);
});
