import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import { installTestDom, mount, click } from "@/test/dom";
import { useRouteSwap } from "./route-swap";

installTestDom();

let reduced = false;
let animations: Keyframe[][] = [];

beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduced-motion") && reduced, media: query })) as typeof window.matchMedia;
  HTMLElement.prototype.animate = function (keyframes: Keyframe[] | PropertyIndexedKeyframes | null) {
    animations.push(keyframes as Keyframe[]);
    return { cancel() {} } as Animation;
  };
});

beforeEach(() => {
  animations = [];
});

afterEach(() => {
  reduced = false;
});

function Shell() {
  const [settings, setSettings] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  useRouteSwap(shell, settings);
  return (
    <div ref={shell}>
      {settings ? (
        <nav>
          <button type="button" aria-current="page">
            General
          </button>
          <button type="button" onClick={() => setSettings(false)}>
            Back
          </button>
        </nav>
      ) : (
        <>
          <div id="turn-prompt" tabIndex={-1} />
          <button type="button" onClick={() => setSettings(true)}>
            Settings
          </button>
        </>
      )}
    </div>
  );
}

const byText = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function go(host: HTMLElement, label: string) {
  const target = byText(host, label);
  act(() => target.focus());
  await click(target);
  await frame();
}

describe("moving between the cockpit and Settings", () => {
  test("the first paint does not animate", async () => {
    await mount(<Shell />);
    expect(animations).toEqual([]);
  });

  test("into Settings fades in and focuses the open section", async () => {
    const { host } = await mount(<Shell />);
    await go(host, "Settings");
    expect(animations).toHaveLength(1);
    expect(animations[0]![0]).toEqual({ opacity: 0, transform: "scale(.985)" });
    expect(document.activeElement?.textContent?.trim()).toBe("General");
  });

  test("back to the cockpit fades in too and focuses the composer", async () => {
    const { host } = await mount(<Shell />);
    await go(host, "Settings");
    await go(host, "Back");
    expect(animations).toHaveLength(2);
    expect(document.activeElement?.id).toBe("turn-prompt");
  });

  test("with reduced motion it switches instantly, and focus still moves", async () => {
    reduced = true;
    const { host } = await mount(<Shell />);
    await go(host, "Settings");
    expect(animations).toEqual([]);
    expect(document.activeElement?.textContent?.trim()).toBe("General");
  });
});
