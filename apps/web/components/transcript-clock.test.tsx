/**
 * #498 — A TICK RE-RENDERS ONE COMPONENT.
 *
 * The elapsed seconds on a live turn used to come from a `useState` clock in
 * `SessionCockpit`, threaded down as a `now` prop. That made the once-a-second
 * advance of two numbers a re-render of the cockpit AND of all ten turns mounted
 * under it — the cost scaled with the length of the conversation, for a readout
 * whose size never changes.
 *
 * WHAT IS PINNED HERE is the shape that fixes it: the clock is INSIDE
 * `WorkingIndicator`, so a tick cannot reach anything the indicator does not
 * render. The probe is an ordinary sibling under a parent that never re-renders
 * of its own accord — exactly where a turn sits relative to the indicator — and
 * it counts its own renders. Under the old shape the state lived in that parent,
 * so every tick rendered the probe again.
 *
 * THE TICK IS FIRED, NOT WAITED FOR. `useSecondsClock` asks `window.setInterval`
 * for it, so the test takes the callback and calls it with the system clock
 * moved on. Nothing here sleeps, and nothing depends on a timer landing inside a
 * test's budget.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkingIndicator } from "./transcript";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STARTED = 1_700_000_000_000;

/** The callbacks `useSecondsClock` has handed to `window.setInterval`. */
let ticks: Array<() => void> = [];
const realSetInterval = window.setInterval;
const realClearInterval = window.clearInterval;

beforeEach(() => {
  ticks = [];
  setSystemTime(new Date(STARTED));
  // Only the repeating timer is taken: React's scheduler reaches for
  // `setTimeout` and a MessageChannel, neither of which this touches.
  window.setInterval = ((handler: () => void) => {
    ticks.push(handler);
    return ticks.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof window.setInterval;
  window.clearInterval = (() => {}) as typeof window.clearInterval;
});

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  window.setInterval = realSetInterval;
  window.clearInterval = realClearInterval;
  setSystemTime();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Counts how many times it has been rendered.
 *
 * A render probe is an IMPURE COMPONENT ON PURPOSE — counting renders is the
 * one thing that cannot be done from an effect, because an effect fires per
 * commit and the question here is whether React called the function at all. The
 * hook rules below are about production components keeping their output a
 * function of their props; this one exists to observe that they do.
 */
let probeRenders = 0;
function Probe() {
  // eslint-disable-next-line react-hooks/globals -- see above: the count IS the observation.
  probeRenders += 1;
  return <span data-testid="probe">probe</span>;
}

/**
 * A turn's worth of tree: something that re-renders on a tick, and something
 * beside it that must not. The parent holds no state of its own — the whole
 * claim is that a tick never reaches it.
 */
function LiveTurn() {
  return (
    <div>
      <Probe />
      <WorkingIndicator label="Working" startedAt={STARTED} lastActivityAt={STARTED} />
    </div>
  );
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(node);
  });
  return host;
}

/** Move the wall clock on and fire every interval the tree registered. */
async function tick(seconds: number) {
  setSystemTime(new Date(STARTED + seconds * 1_000));
  await act(async () => {
    for (const fire of ticks) fire();
  });
}

describe("the working indicator's clock", () => {
  test("advances the elapsed readout without re-rendering its sibling", async () => {
    probeRenders = 0;
    const host = await mount(<LiveTurn />);
    expect(host.textContent).toContain("0s");
    expect(probeRenders).toBe(1);

    await tick(1);
    expect(host.textContent).toContain("1s");
    // THE WHOLE POINT: one tick, one component re-rendered. The sibling standing
    // in for a mounted turn was not asked to render again.
    expect(probeRenders).toBe(1);

    await tick(42);
    expect(host.textContent).toContain("42s");
    expect(probeRenders).toBe(1);
  });

  test("registers exactly one interval for a live turn, and drops it on unmount", async () => {
    await mount(<LiveTurn />);
    expect(ticks).toHaveLength(1);

    let cleared = 0;
    window.clearInterval = (() => {
      cleared += 1;
    }) as typeof window.clearInterval;
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    expect(cleared).toBe(1);
  });

  test("a settled turn has no clock at all — the indicator is not mounted", async () => {
    // The cockpit renders `WorkingIndicator` only while `live`, so this is the
    // shape of a finished turn: nothing asked for an interval.
    await mount(
      <div>
        <Probe />
      </div>,
    );
    expect(ticks).toHaveLength(0);
  });
});
