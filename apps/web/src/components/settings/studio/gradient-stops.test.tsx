/**
 * THE SELECTED STOP HAS A COLOUR — round four of #471.
 *
 * "The new gradient editor looks nice, but we should let the user set the
 * colours too." Round three put an `<input type="color">` behind each swatch,
 * which meant the ONLY way to set a colour was to open the operating system's
 * colour dialog, and the only way to discover that was to try clicking a
 * swatch. What is pinned here is the three ways in that replaced it — a hex you
 * can type (in any notation this app writes), the colours already in play, and
 * the screen itself — and the one thing each of them must do, which is reach
 * the spec.
 *
 * MOUNTED, NOT SERVER-RENDERED: the eyedropper is a capability asked for after
 * mount, and typing is the whole subject.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { GradientStops } = await import("./gradient-stops");
const { forgetRecentColours } = await import("@/lib/recent-colours");
const { DEFAULT_GRADIENT_SPECS } = await import("@/lib/gradient-starters");
const { clearField, typeInto } = await import("@/lib/testing/type-into");
type Spec = (typeof DEFAULT_GRADIENT_SPECS)["light"];

/** The app's own colours the chip row always offers, distinct enough from each
 *  other and from the default stops that every assertion below is unambiguous. */
const COLOURS = { light: "#f7f7f7", dark: "#0b0b10", accent: "oklch(0.488 0.16 264)" };
const ACCENT_HEX = "#2f58b9";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;
/** The last spec the editor handed up — what "reaching the spec" means. */
let spec: Spec;

/** The editor with the one thing around it that it needs: something holding the
 *  spec it hands up, the way the layer stack does. `spec` is that state, read
 *  back out so an assertion can ask what actually reached it. */
function Harness({ initial }: { initial: Spec }) {
  const [current, setCurrent] = useState(initial);
  useEffect(() => {
    spec = current;
  }, [current]);
  return <GradientStops spec={current} mode="light" colours={COLOURS} onChange={setCurrent} onClose={() => undefined} />;
}

async function mountEditor(): Promise<void> {
  // UNMOUNTED, NOT JUST DETACHED. The editor subscribes to the session's colour
  // list; a root left mounted would still be told when the next test clears it.
  await unmountEditor();
  host = document.createElement("div");
  document.body.appendChild(host);
  const fresh = createRoot(host);
  root = fresh;
  await act(async () => {
    fresh.render(<Harness initial={spec} />);
  });
}

async function unmountEditor(): Promise<void> {
  const mounted = root;
  if (!mounted) return;
  root = undefined;
  await act(async () => {
    mounted.unmount();
  });
  host.remove();
}

beforeEach(async () => {
  await unmountEditor();
  forgetRecentColours();
  delete (window as { EyeDropper?: unknown }).EyeDropper;
  spec = { ...DEFAULT_GRADIENT_SPECS.light, stops: [...DEFAULT_GRADIENT_SPECS.light.stops] };
  await mountEditor();
});

afterAll(async () => {
  await unmountEditor();
  GlobalRegistrator.unregister();
});

function byLabel<T extends Element = HTMLInputElement>(label: string): T | null {
  return host.querySelector(`[aria-label="${label}"]`);
}

/**
 * Replace what is in the hex field with `text`, typed.
 *
 * FOCUS FIRST, AND IT IS NOT CEREMONY: HexField shows its own draft only while
 * `editing`, which `onFocus` turns on. Typing into an unfocused field would
 * append to the committed value instead of the draft, and the live commits
 * along the way would then be read back as input.
 *
 * ONE CHARACTER AT A TIME, through `typeInto` (lib/testing/type-into.ts) —
 * which is the repo's answer to #732 and the reason this file does not roll its
 * own. It also makes the live field honest: "#1e1e2e" really does pass through
 * "#1e1" on the way, so what these tests assert is the value that LANDS rather
 * than the only one that was ever offered.
 */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  await clearField(input);
  await typeInto(input, text);
}

/**
 * What the OS colour dialog does when it hands a colour back: the whole value
 * at once, and an `input` event over it. NOT `typeInto` — nobody types into an
 * `<input type="color">`, and a per-character "#", "#f", "#ff" is not a colour
 * the control could ever hold.
 */
async function pickInDialog(input: HTMLInputElement, hex: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, hex);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const hexField = () => byLabel<HTMLInputElement>("Selected stop hex value")!;
const swatch = () => byLabel<HTMLInputElement>("Selected stop colour")!;
const chips = () => [...host.querySelectorAll('[aria-label="Colours already in play"] button')] as HTMLButtonElement[];

describe("the selected stop's colour field", () => {
  test("it is a labelled control, not a swatch you have to guess at", () => {
    expect(host.textContent).toContain("Colour");
    expect(swatch().getAttribute("type")).toBe("color");
    expect(hexField()).not.toBeNull();
    // The strip's own per-stop pickers survive as the shortcut they were.
    expect(host.querySelectorAll('input[type="color"][aria-label^="Stop "]')).toHaveLength(spec.stops.length);
  });

  test("a typed hex reaches the spec, live", async () => {
    await type(hexField(), "#1e1e2e");
    expect(spec.stops[0]!.color).toBe("#1e1e2e");
  });

  test("the short form and a bare one land too", async () => {
    await type(hexField(), "#abc");
    expect(spec.stops[0]!.color).toBe("#aabbcc");
    await type(hexField(), "112233");
    expect(spec.stops[0]!.color).toBe("#112233");
  });

  /** The token rows one group up are written in oklch, so a reader who can SEE
   *  a value there has to be able to paste it here. */
  test("an oklch value lands as normalised hex", async () => {
    await type(hexField(), "oklch(0.488 0.16 264)");
    expect(spec.stops[0]!.color).toBe(ACCENT_HEX);
  });

  test("something that is not a colour changes nothing and snaps back", async () => {
    const before = spec.stops[0]!.color;
    await type(hexField(), "bananas");
    expect(spec.stops[0]!.color).toBe(before);
    await blur(hexField());
    expect(hexField().value).toBe(before);
  });

  test("the swatch still opens the OS picker for the stop", async () => {
    await pickInDialog(swatch(), "#ff0000");
    expect(spec.stops[0]!.color).toBe("#ff0000");
  });
});

describe("the colours already in play", () => {
  test("both bases and the accent are offered before anything has been touched", () => {
    expect(chips().map((chip) => chip.getAttribute("aria-label"))).toEqual(["Use Light base", "Use Dark base", "Use Accent"]);
  });

  test("clicking one applies it to the selected stop", async () => {
    await act(async () => {
      chips()[2]?.click();
    });
    expect(spec.stops[0]!.color).toBe(ACCENT_HEX);
  });

  /** A native colour dialog fires `change` continuously as the cursor moves
   *  through it, and the hex field commits per keystroke — remembering either
   *  as it happened would fill a list of eight with one drag. */
  test("a colour is remembered when the gesture ends, not while it is happening", async () => {
    await type(hexField(), "#123456");
    expect(chips()).toHaveLength(3);
    await blur(hexField());
    expect(chips().map((chip) => chip.getAttribute("aria-label")).at(-1)).toBe("Use #123456");
  });

  test("a recent that is already a named chip is not offered twice", async () => {
    await act(async () => {
      chips()[0]?.click();
    });
    expect(chips().map((chip) => chip.getAttribute("aria-label"))).toEqual(["Use Light base", "Use Dark base", "Use Accent"]);
  });
});

describe("the eyedropper", () => {
  test("it is absent where the browser has none, rather than present and broken", () => {
    expect(byLabel("Pick a colour from the screen")).toBeNull();
  });

  test("where there is one, what it picks becomes the stop", async () => {
    (window as { EyeDropper?: unknown }).EyeDropper = class {
      open = async () => ({ sRGBHex: "#00FF80" });
    };
    await mountEditor();
    const button = byLabel<HTMLButtonElement>("Pick a colour from the screen");
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });
    expect(spec.stops[0]!.color).toBe("#00ff80");
    // Deliberately chosen, so it is worth remembering at once.
    expect(chips().map((chip) => chip.getAttribute("aria-label")).at(-1)).toBe("Use #00ff80");
  });

  test("dismissing it changes nothing", async () => {
    (window as { EyeDropper?: unknown }).EyeDropper = class {
      open = async () => {
        throw new DOMException("aborted", "AbortError");
      };
    };
    await mountEditor();
    const before = spec.stops[0]!.color;
    await act(async () => {
      byLabel<HTMLButtonElement>("Pick a colour from the screen")?.click();
    });
    expect(spec.stops[0]!.color).toBe(before);
  });
});
