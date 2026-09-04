// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import { installClipboardShim } from "./clipboard";

const saved = { window: globalThis.window, navigator: globalThis.navigator, document: globalThis.document };

afterEach(() => {
  Object.assign(globalThis, saved);
});

function insecureOrigin(): { copied: string[] } {
  const copied: string[] = [];
  let selected = "";
  const stage = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute() {},
    select() {
      selected = this.value;
    },
    setSelectionRange() {},
    remove() {},
  };
  Object.assign(globalThis, {
    window: {},
    navigator: {},
    document: {
      createElement: () => stage,
      body: { appendChild() {} },
      activeElement: null,
      execCommand(command: string) {
        if (command !== "copy") return false;
        copied.push(selected);
        return true;
      },
    },
  });
  return { copied };
}

describe("installClipboardShim", () => {
  test("on an insecure origin, writeText copies through the selection", async () => {
    const { copied } = insecureOrigin();
    expect(installClipboardShim()).toBe(true);
    await navigator.clipboard.writeText("bun add telar");
    expect(copied).toEqual(["bun add telar"]);
  });

  test("a real clipboard is left alone", () => {
    const writeText = () => Promise.resolve();
    Object.assign(globalThis, { window: {}, navigator: { clipboard: { writeText } }, document: {} });
    expect(installClipboardShim()).toBe(false);
    expect(navigator.clipboard.writeText).toBe(writeText);
  });

  test("a refused copy rejects, so a caller can leave the text selectable", async () => {
    insecureOrigin();
    (globalThis.document as { execCommand: () => boolean }).execCommand = () => false;
    installClipboardShim();
    await expect(navigator.clipboard.writeText("x")).rejects.toThrow();
  });
});
