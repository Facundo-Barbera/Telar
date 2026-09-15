/**
 * #498 — A TURN FAR FROM THE VIEWPORT IS SKIPPED, AND KEEPS ITS SIZE.
 *
 * Paging history in mounts turns and never unmounts them, so a reader walking
 * back through a long session ends up with hundreds of turns of layout, style
 * and paint live at once. `content-visibility: auto` is the browser's own
 * answer — but only if the skipped subtree still occupies the right space, or
 * the scrollbar lurches every time one goes out of view.
 *
 * WHAT IS PINNED HERE: the height comes from the REAL render (so the element
 * cannot change size at the moment it starts being skipped), it is taken once
 * rather than re-read off the placeholder, and the LIVE turn — whose height
 * moves with every delta, and which is at the bottom of the window where the
 * property would do nothing — is never given it at all.
 *
 * happy-dom lays nothing out, so `offsetHeight` is stubbed. That is the only
 * stub: the property writes and the once-only rule are the component's own.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TurnFrame } from "./session-cockpit";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The height every element reports, until a test changes it. Stubbed on the
 * PROTOTYPE because the frame measures a node it created itself, which the test
 * has no handle on until after the measurement has already happened.
 */
let laidOutHeight = 0;
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  get() {
    return laidOutHeight;
  },
  configurable: true,
});

afterAll(async () => {
  // The suite shares a process and these globals outlive this file, so the
  // prototype is handed back exactly as it was found.
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  await GlobalRegistrator.unregister();
});

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  laidOutHeight = 0;
});

async function mount(skippable: boolean, height: number) {
  laidOutHeight = height;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (nextSkippable: boolean) => {
    await act(async () => {
      root.render(
        <TurnFrame skippable={nextSkippable}>
          <p>a turn</p>
        </TurnFrame>,
      );
    });
  };
  await render(skippable);
  return { frame: host.firstElementChild as HTMLElement, render };
}

const skipping = (frame: HTMLElement) => ({
  visibility: frame.style.getPropertyValue("content-visibility"),
  size: frame.style.getPropertyValue("contain-intrinsic-size"),
});

describe("a settled turn's frame", () => {
  test("is skippable at the size it actually rendered at", async () => {
    const { frame } = await mount(true, 482);
    expect(skipping(frame)).toEqual({ visibility: "auto", size: "auto 482px" });
  });

  test("keeps `auto`, so the browser's own last-rendered size outranks the seed", async () => {
    // `contain-intrinsic-size: auto <length>` means "remember what this really
    // was; use the length only until you have". A bare length would freeze the
    // placeholder at whatever the first paint happened to measure.
    const { frame } = await mount(true, 300);
    expect(frame.style.getPropertyValue("contain-intrinsic-size")).toStartWith("auto ");
  });

  test("measures once — a later pass never reads the placeholder back", async () => {
    const { frame, render } = await mount(true, 482);
    // What `offsetHeight` answers for a SKIPPED element is its intrinsic size,
    // not its content's. Re-measuring would lock that in and shrink the turn.
    laidOutHeight = 12;
    await render(true);
    expect(frame.style.getPropertyValue("contain-intrinsic-size")).toBe("auto 482px");
  });
});

describe("the live turn's frame", () => {
  test("is never skipped — it is at the bottom of the window and still growing", async () => {
    const { frame } = await mount(false, 482);
    expect(skipping(frame)).toEqual({ visibility: "", size: "" });
  });

  test("becomes skippable once the turn settles, at the height it finished on", async () => {
    const { frame, render } = await mount(false, 482);
    laidOutHeight = 940;
    await render(true);
    expect(skipping(frame)).toEqual({ visibility: "auto", size: "auto 940px" });
  });

  test("gives the properties back if it goes live again", async () => {
    const { frame, render } = await mount(true, 482);
    await render(false);
    expect(skipping(frame)).toEqual({ visibility: "", size: "" });
  });
});

describe("a turn the browser has not laid out yet", () => {
  test("is left alone rather than pinned to nothing", async () => {
    // A zero measurement is "not laid out", never "this turn is empty" — an
    // `auto 0px` placeholder would collapse it and take the scrollbar with it.
    const { frame } = await mount(true, 0);
    expect(skipping(frame)).toEqual({ visibility: "", size: "" });
  });
});
