import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { frameWriter, ITEM_CHARS } from "./frames";

let queued: Array<() => void> = [];
const real = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };

beforeEach(() => {
  queued = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => queued.push(() => callback(0))) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    queued[id - 1] = () => {};
  }) as typeof cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = real.request;
  globalThis.cancelAnimationFrame = real.cancel;
});

const nextFrame = () => {
  for (const run of queued.splice(0)) run();
};

describe("output batched per frame", () => {
  test("chunks pushed within one frame reach the emulator as one write, in order", () => {
    const written: string[] = [];
    const frames = frameWriter((data) => written.push(data));
    frames.push("a");
    frames.push("b");
    frames.push("c");
    expect(written).toEqual([]);
    nextFrame();
    expect(written).toEqual(["abc"]);
    frames.push("d");
    nextFrame();
    expect(written).toEqual(["abc", "d"]);
  });

  test("a frame's output is cut into items no larger than the parser's yield unit", () => {
    const written: string[] = [];
    const frames = frameWriter((data) => written.push(data));
    const chunk = "x".repeat(ITEM_CHARS / 4);
    for (let at = 0; at < 10; at += 1) frames.push(chunk);
    nextFrame();
    expect(written.join("")).toBe(chunk.repeat(10));
    expect(written.every((item) => item.length <= ITEM_CHARS)).toBe(true);
    expect(written).toHaveLength(3);
  });

  test("cancel drops what has not been drawn, and flush draws it now", () => {
    const written: string[] = [];
    const frames = frameWriter((data) => written.push(data));
    frames.push("gone");
    frames.cancel();
    nextFrame();
    expect(written).toEqual([]);
    frames.push("now");
    frames.flush();
    expect(written).toEqual(["now"]);
    nextFrame();
    expect(written).toEqual(["now"]);
  });

  test("a queue that grows past its bound without a frame is written at once", () => {
    const written: string[] = [];
    const frames = frameWriter((data) => written.push(data));
    for (let at = 0; at < 70; at += 1) frames.push("y".repeat(ITEM_CHARS));
    expect(written.length).toBeGreaterThan(0);
  });
});
