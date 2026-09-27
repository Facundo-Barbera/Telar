/**
 * THE AT-BOTTOM REPORT DOES NOT PING-PONG WITH THE COMPOSER IT DRIVES (#1020).
 *
 * `onAtBottomChange` drives the composer's compact shape, and the composer is a
 * flex SIBLING of the viewport: compacting it makes the viewport taller, which
 * brings the end closer, which could flip the report back. Pinned here:
 *
 *   - READING BACK STAYS READING BACK while a turn streams, however much the
 *     compact composer gives back — no flip per chunk.
 *   - A SWITCH SETTLES: bounded flips and renders, the composer is not compact
 *     while the conversation opens, and the viewport lands at the end.
 *   - FOLLOW MODE SURVIVES: back at the end, a streaming turn is followed.
 *
 * THE LAYOUT IS STUBBED, because happy-dom has none: the scroll element's
 * `clientHeight` is the viewport plus what a compact composer gives back,
 * `scrollHeight` is the transcript, and `scrollTop` clamps and fires `scroll` a
 * task later the way a browser does. ResizeObserver is fired by hand.
 *
 * THE CLOCK IS STUBBED TOO: `setTimeout`, `requestAnimationFrame`, `Date.now`
 * and `performance.now` all read one manual clock that `advance` moves, so the
 * library's frames and timeouts run in order with no real time passing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useCallback, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { ConversationContent, ConversationViewport, READING_BACK_PX } from "./conversation";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Observed = { callback: (entries: Array<{ contentRect: { height: number } }>) => void; target?: Element };
let observed: Observed[] = [];

class FakeResizeObserver {
  readonly record: Observed;
  constructor(callback: Observed["callback"]) {
    this.record = { callback };
    observed.push(this.record);
  }
  observe(target: Element) {
    this.record.target = target;
  }
  unobserve() {}
  disconnect() {}
}

/** One manual clock behind every timer the library reads. */
const clock = (() => {
  let now = 0;
  let nextId = 1;
  let timers: Array<{ id: number; at: number; run: () => void }> = [];
  const schedule = (run: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, at: now + Math.max(0, ms), run });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]) => schedule(() => fn(...args), ms),
    clearTimeout: (id: number) => { timers = timers.filter((timer) => timer.id !== id); },
    requestAnimationFrame: (fn: (at: number) => void) => schedule(() => fn(now), 16),
    reset: () => { now = 0; timers = []; },
    /** Run everything due within `ms`, in order, letting promises settle between. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.run();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
    },
  };
})();

const real = {
  ResizeObserver: globalThis.ResizeObserver,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  dateNow: Date.now,
  performanceNow: performance.now,
};
const start = Date.parse("2026-09-26T00:00:00Z");
const fakes = globalThis as unknown as Record<string, unknown>;

const roots: Root[] = [];

beforeEach(() => {
  clock.reset();
  fakes.ResizeObserver = FakeResizeObserver;
  fakes.setTimeout = clock.setTimeout;
  fakes.clearTimeout = clock.clearTimeout;
  fakes.requestAnimationFrame = clock.requestAnimationFrame;
  fakes.cancelAnimationFrame = clock.clearTimeout;
  Date.now = () => start + clock.now();
  performance.now = () => clock.now();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  Object.assign(fakes, {
    ResizeObserver: real.ResizeObserver,
    setTimeout: real.setTimeout,
    clearTimeout: real.clearTimeout,
    requestAnimationFrame: real.requestAnimationFrame,
    cancelAnimationFrame: real.cancelAnimationFrame,
  });
  Date.now = real.dateNow;
  performance.now = real.performanceNow;
  document.body.innerHTML = "";
  observed = [];
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const tick = (ms: number) => act(() => clock.advance(ms));

/** The library's own `STICK_TO_BOTTOM_OFFSET_PX`. */
const AT_END_PX = 70;
const VIEWPORT_PX = 600;

/**
 * A cockpit in miniature: a viewport, and a composer beside it that is compact
 * while the reader is reading back AND the conversation has landed — the
 * cockpit's rule — and gives `composerDelta` pixels back to the viewport then.
 */
async function mountCockpit(composerDelta: number) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  const context: { current: StickToBottomContext | null } = { current: null };
  const flips: boolean[] = [];
  const compactWhileOpening: boolean[] = [];
  let renders = 0;
  let transcriptPx = 5_000;
  let compact = false;
  let top = 0;
  const scroll: { element?: HTMLElement } = {};
  const clientPx = () => VIEWPORT_PX + (compact ? composerDelta : 0);
  const maxTop = () => Math.max(0, transcriptPx - clientPx());
  /** A browser clamps `scrollTop` when the room shrinks, and says so a task later. */
  const moveTo = (next: number) => {
    const clamped = Math.max(0, Math.min(next, maxTop()));
    if (clamped === top) return;
    top = clamped;
    setTimeout(() => scroll.element?.dispatchEvent(new Event("scroll")), 0);
  };

  let open: (conversation: { at: string; landed: boolean }) => void = () => undefined;

  function Cockpit() {
    renders += 1;
    const [readingBack, setReadingBack] = useState(false);
    const [conversation, setConversation] = useState({ at: "session_a", landed: true });
    open = setConversation;
    const onAtBottomChange = useCallback((atBottom: boolean) => {
      flips.push(atBottom);
      setReadingBack(!atBottom);
    }, []);
    const shape = readingBack && conversation.landed;
    // The composer's height IS the viewport's, so its shape is layout.
    useLayoutEffect(() => {
      compact = shape;
      if (!conversation.landed) compactWhileOpening.push(shape);
      moveTo(top);
    });
    return (
      <ConversationViewport
        conversation={conversation.at}
        landed={conversation.landed}
        contextRef={context}
        onAtBottomChange={onAtBottomChange}
      >
        <ConversationContent>
          <p>a turn</p>
        </ConversationContent>
      </ConversationViewport>
    );
  }

  await act(async () => {
    root.render(<Cockpit />);
  });

  const scroller = context.current!.scrollRef.current!;
  scroll.element = scroller;
  Object.defineProperty(scroller, "scrollHeight", { get: () => transcriptPx, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => clientPx(), configurable: true });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: moveTo, configurable: true });
  const content = observed.find((entry) => entry.target === context.current!.contentRef.current)!;

  return {
    flips,
    compactWhileOpening,
    renders: () => renders,
    distance: () => transcriptPx - clientPx() - top,
    compact: () => compact,
    transcriptPx: () => transcriptPx,
    /** The transcript is now `px` tall — the library hears it through its observer. */
    resize: (px: number) => {
      transcriptPx = px;
      moveTo(top);
      content.callback([{ contentRect: { height: px } }]);
    },
    open: (at: string, landed: boolean) => open({ at, landed }),
    toBottom: () => context.current!.scrollToBottom("instant"),
    /** The reader's own gesture: a wheel up, and the scroll it performs. */
    readBack: (px: number) => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -px }));
      moveTo(top - px);
    },
  };
}

type Cockpit = Awaited<ReturnType<typeof mountCockpit>>;

async function stream(cockpit: Cockpit, chunks: number) {
  for (let chunk = 0; chunk < chunks; chunk++) {
    await act(async () => {
      cockpit.resize(cockpit.transcriptPx() + 20);
      await clock.advance(40);
    });
  }
}

async function readingBack(composerDelta: number, px: number) {
  const cockpit = await mountCockpit(composerDelta);
  await act(async () => {
    cockpit.resize(5_000);
    void cockpit.toBottom();
    await clock.advance(80);
  });
  await tick(300);
  await act(async () => {
    cockpit.readBack(px);
    await clock.advance(50);
  });
  await tick(400);
  return cockpit;
}

describe("the compact composer and the at-bottom report", () => {
  // Either side of the library's 70px slack — the second is the size at which
  // compacting alone used to carry the reader back across it.
  for (const composerDelta of [40, 120]) {
    test(`reading back holds while a turn streams (composer gives back ${composerDelta}px)`, async () => {
      const cockpit = await readingBack(composerDelta, READING_BACK_PX + 100);
      expect(cockpit.compact()).toBe(true);
      expect(cockpit.flips.at(-1)).toBe(false);

      cockpit.flips.length = 0;
      const rendersBefore = cockpit.renders();
      await stream(cockpit, 10);
      await tick(300);
      expect(cockpit.flips).toEqual([]);
      expect(cockpit.renders()).toBe(rendersBefore);
      expect(cockpit.compact()).toBe(true);
    });

    test(`a small scroll up does not compact the composer (composer gives back ${composerDelta}px)`, async () => {
      const cockpit = await readingBack(composerDelta, 100);
      await stream(cockpit, 10);
      await tick(300);
      expect(cockpit.flips.filter((atBottom) => !atBottom)).toEqual([]);
      expect(cockpit.compact()).toBe(false);
    });

    test(`a switch settles, opens uncompact, and follows the end (composer gives back ${composerDelta}px)`, async () => {
      const cockpit = await readingBack(composerDelta, READING_BACK_PX + 100);
      await stream(cockpit, 5);
      expect(cockpit.compact()).toBe(true);

      cockpit.flips.length = 0;
      const rendersBefore = cockpit.renders();

      // The switch: A's rows still in state, then an empty transcript, then the
      // hydrated one arriving in the commit that says it landed.
      await act(async () => {
        cockpit.open("session_b", false);
        await clock.advance(30);
      });
      await act(async () => {
        cockpit.resize(300);
        await clock.advance(50);
      });
      await act(async () => {
        cockpit.open("session_b", true);
        cockpit.resize(4_000);
        await clock.advance(100);
      });
      await tick(500);

      expect(cockpit.compactWhileOpening.length).toBeGreaterThan(0);
      expect(cockpit.compactWhileOpening.every((shape) => !shape)).toBe(true);
      expect(cockpit.flips.length).toBeLessThanOrEqual(2);
      expect(cockpit.flips.at(-1)).toBe(true);
      expect(cockpit.renders() - rendersBefore).toBeLessThanOrEqual(6);
      expect(cockpit.distance()).toBeLessThanOrEqual(AT_END_PX);
      expect(cockpit.compact()).toBe(false);

      // Follow mode: a turn streaming into B keeps the reader at its end.
      cockpit.flips.length = 0;
      await stream(cockpit, 10);
      await tick(1_000);
      expect(cockpit.flips).toEqual([]);
      expect(cockpit.distance()).toBeLessThanOrEqual(AT_END_PX);

      // And it has stopped: nothing further happens with nothing going on.
      const rendersSettled = cockpit.renders();
      await tick(1_000);
      expect(cockpit.renders()).toBe(rendersSettled);
    });
  }
});
