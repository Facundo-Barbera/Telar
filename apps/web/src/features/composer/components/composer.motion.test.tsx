import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { installTestDom, mount, flush, click, stubFetch } from "@/test/dom";
import { Composer } from "./composer";

installTestDom();

const layout = { width: 2000, height: 120, reduced: false, observers: new Set<() => void>() };
let animations: { target: HTMLElement; keyframes: Keyframe[] }[] = [];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    readonly fire: () => void;
    constructor(callback: () => void) {
      this.fire = () => callback();
    }
    observe() {
      layout.observers.add(this.fire);
    }
    unobserve() {}
    disconnect() {
      layout.observers.delete(this.fire);
    }
  } as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduced-motion") && layout.reduced, media: query })) as typeof window.matchMedia;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => layout.width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => layout.height });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 0 });
  HTMLElement.prototype.animate = function (this: HTMLElement, keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    animations.push({ target: this, keyframes: keyframes as Keyframe[] });
    return { cancel() {} } as Animation;
  };
  HTMLElement.prototype.getAnimations = () => [];
});

beforeEach(() => {
  animations = [];
  stubFetch({});
});

afterEach(() => {
  Object.assign(layout, { width: 2000, height: 120, reduced: false });
});

function Box({ busy = false }: { busy?: boolean }) {
  const [draft, setDraft] = useState("");
  const [compact, setCompact] = useState(false);
  const [running, setRunning] = useState(busy);
  return (
    <>
      <button type="button" onClick={() => setCompact((value) => !value)}>
        scroll
      </button>
      <button type="button" onClick={() => setRunning((value) => !value)}>
        run
      </button>
      <Composer
        draft={draft}
        ready
        attachments={[]}
        onAttach={() => {}}
        busy={running}
        compact={compact}
        sending={false}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={() => {}}
        onStop={() => {}}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
      />
    </>
  );
}

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
const expand = (host: HTMLElement) => host.querySelector('button[aria-label="Open the full composer"]');
const heights = () => animations.filter((run) => "height" in (run.keyframes[0] ?? {})).map((run) => run.keyframes.map((frame) => frame.height));

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function settled(props: { busy?: boolean } = {}) {
  const { host } = await mount(<Box {...props} />);
  await flush();
  await frame();
  await flush();
  animations = [];
  return host;
}

describe("the composer's transitions", () => {
  test("collapsing morphs the height from the old size to the new one and lands on the mini form", async () => {
    const host = await settled();
    layout.height = 44;
    await click(button(host, "scroll"));
    expect(heights()).toEqual([["120px", "44px"]]);
    expect(animations.some((run) => run.keyframes[0]?.opacity === 0)).toBe(true);
    expect(expand(host)).not.toBeNull();
  });

  test("with reduced motion nothing animates, and it still lands on the mini form", async () => {
    layout.reduced = true;
    const host = await settled();
    layout.height = 44;
    await click(button(host, "scroll"));
    expect(animations).toEqual([]);
    expect(expand(host)).not.toBeNull();
  });

  test("the first paint does not animate, even when it opens narrow", async () => {
    layout.width = 300;
    const { host } = await mount(<Box />);
    await flush();
    expect(animations).toEqual([]);
    expect(expand(host)).not.toBeNull();
  });

  test("height that follows typed text is not animated", async () => {
    await settled();
    layout.height = 160;
    act(() => {
      for (const fire of [...layout.observers]) fire();
    });
    await flush();
    expect(animations).toEqual([]);
  });

  test("Send turning into Stop cross-fades the icon", async () => {
    const host = await settled();
    await click(button(host, "run"));
    expect(host.querySelector('button[aria-label="Stop"]')).not.toBeNull();
    expect(animations.some((run) => run.keyframes[0]?.transform === "scale(.6)")).toBe(true);
  });
});
