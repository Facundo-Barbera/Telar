/**
 * The fold and the copy are the two promises this surface makes: the fold
 * never loses a line, and copy always has all of them. Asserted on the pure
 * helper and on the mounted component — the button is clicked and the
 * clipboard is asked what it received (#760; these were source pins once).
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CODE_SURFACE_LINES, CodeSurface, foldLines } = await import("./code-surface");

describe("foldLines", () => {
  test("short output is untouched and counts its lines", () => {
    expect(foldLines("a\nb")).toEqual({ shown: "a\nb", hidden: 0, total: 2 });
    expect(foldLines("")).toEqual({ shown: "", hidden: 0, total: 1 });
  });

  test("exactly the limit is not folded; one more is", () => {
    const at = Array.from({ length: CODE_SURFACE_LINES }, (_, i) => `l${i}`).join("\n");
    expect(foldLines(at).hidden).toBe(0);
    const over = `${at}\nextra`;
    const folded = foldLines(over);
    expect(folded.hidden).toBe(1);
    expect(folded.total).toBe(CODE_SURFACE_LINES + 1);
    expect(folded.shown.split("\n")).toHaveLength(CODE_SURFACE_LINES);
    expect(folded.shown.endsWith("extra")).toBe(false);
  });

  test("CRLF output keeps its bytes — only \\n splits", () => {
    const text = Array.from({ length: 30 }, (_, i) => `r${i}\r`).join("\n");
    expect(foldLines(text).shown).toContain("\r");
  });
});

describe("CodeSurface, mounted", () => {
  const long = Array.from({ length: CODE_SURFACE_LINES + 6 }, (_, i) => `line ${i}`).join("\n");
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | undefined;

  async function mount(text: string, clipboard: (text: string) => Promise<void>): Promise<void> {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<CodeSurface text={text} />));
  }

  const click = (element: Element | null) => act(async () => (element as HTMLElement).click());
  const copy = () => host.querySelector('button[aria-label^="Cop"]');
  const toggle = () => host.querySelector("button[aria-expanded]");

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    host?.remove();
  });

  afterAll(() => GlobalRegistrator.unregister());

  test("copy receives the whole text while the fold shows a slice", async () => {
    const written: string[] = [];
    await mount(long, async (text) => void written.push(text));
    expect(host.querySelector("pre")?.textContent).not.toContain(`line ${CODE_SURFACE_LINES}`);
    await click(copy());
    expect(written).toEqual([long]);
    expect(copy()?.getAttribute("aria-label")).toBe("Copied");
  });

  test("a refused clipboard is shown, not swallowed", async () => {
    await mount("x", () => Promise.reject(new Error("denied")));
    await click(copy());
    expect(copy()?.getAttribute("aria-label")).toBe("Copy failed");
  });

  test("the fold toggle names both directions and its state", async () => {
    await mount(long, async () => undefined);
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle()?.textContent).toBe(`Show all · ${CODE_SURFACE_LINES + 6} lines`);
    await click(toggle());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle()?.textContent).toBe("Show less");
    expect(host.querySelector("pre")?.textContent).toBe(long);
  });
});
