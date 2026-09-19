// @ts-expect-error bun:test is the test runner
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { isReplacement, useStreamingReveal } from "./use-streaming-reveal";

/**
 * THE HOOK ITSELF, not the pacer behind it.
 *
 * SERVER RENDERING ONLY, AND THAT IS A REAL LIMIT. Each call is a fresh mount:
 * `useEffect` never runs, no frame is ever scheduled, and no existing hook is
 * updated. So these cover exactly the paths that must return the whole text
 * with no effect and no frame — a first paint — and NOTHING dynamic. Pacing
 * across arrivals is covered against `stepReveal` in streaming-reveal.test.ts;
 * everything that needs a commit, a frame or a preference change lives in
 * use-streaming-reveal.dom.test.tsx, which mounts this hook for real.
 */
function shown(target: string, streaming: boolean): string {
  const Probe = ({ text, live }: { text: string; live: boolean }) => createElement("i", null, useStreamingReveal(text, live));
  const html = renderToString(createElement(Probe, { text: target, live: streaming }));
  // renderToString escapes for HTML; undo that so these compare TEXT.
  return html
    .replace(/^<i>|<\/i>$/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const media = globalThis.window?.matchMedia;
afterEach(() => {
  if (globalThis.window && media) globalThis.window.matchMedia = media;
});

describe("replacement detection", () => {
  // The hook's own branch, exported so it can be tested without a DOM.
  test("continuing text is not a replacement", () => {
    expect(isReplacement("Once upon a time", 10, "Once upon a time, there was")).toBe(false);
  });

  test("a revision of the SAME length is a replacement", () => {
    // The case length cannot catch, and the reason this is not a comparison of
    // sizes: same length, different words after the shown prefix.
    expect(isReplacement("the cat sat on the mat", 12, "the cat ate on the mat")).toBe(true);
  });

  test("a LONGER revision that diverges is still a replacement", () => {
    expect(isReplacement("hello world", 11, "hello there, world and more")).toBe(true);
  });

  test("nothing shown yet is never a replacement", () => {
    expect(isReplacement("anything at all", 0, "something else entirely")).toBe(false);
  });
});

describe("useStreamingReveal on first paint", () => {
  test("a first paint mid-reply shows what has already streamed, not an animation of it", () => {
    // THE #214 CONTRACT AT THE HOOK. Seeding at zero would replay 600
    // characters the reader watched arrive before they switched surface.
    const arrived = "y".repeat(600);
    expect(shown(arrived, true)).toBe(arrived);
  });

  test("a completed turn renders everything, with no frame needed", () => {
    // Completion and Stop are the same exit: `streaming` goes false and the
    // text is whole immediately, not after pacing catches up.
    expect(shown("the finished answer", false)).toBe("the finished answer");
  });

  test("an empty reply is not a special case", () => {
    expect(shown("", true)).toBe("");
    expect(shown("", false)).toBe("");
  });

  test("text is never altered on the way through", () => {
    const awkward = "code `x < y` & \"quotes\" — 👋🏽 done";
    expect(shown(awkward, false)).toBe(awkward);
  });
});
