// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toLineRange } from "./diff-code-view";
import { LineRangeAction } from "./line-range-action";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the library's selection, in a reference's words", () => {
  test("added and context lines count today's file; removed lines count the file before", () => {
    expect(toLineRange({ start: 3, end: 8, side: "additions" })).toEqual({ start: 3, end: 8, startSide: "after", endSide: "after" });
    expect(toLineRange({ start: 3, end: 8 })).toEqual({ start: 3, end: 8, startSide: "after", endSide: "after" });
    expect(toLineRange({ start: 3, end: 8, side: "deletions" })).toEqual({ start: 3, end: 8, startSide: "before", endSide: "before" });
    expect(toLineRange({ start: 3, end: 8, side: "deletions", endSide: "additions" })).toEqual({ start: 3, end: 8, startSide: "before", endSide: "after" });
  });
});

describe("the Add to message button", () => {
  async function mount(onInsert: (text: string) => void) {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () =>
      root.render(<LineRangeAction path="src/new-name.ts" range={{ start: 10, end: 20, startSide: "after", endSide: "after" }} onInsert={onInsert} />),
    );
    return { composer, button: host.querySelector("button")! };
  }

  test("inserts the range reference, named by the row's path", async () => {
    const inserted: string[] = [];
    const { button } = await mount((text) => inserted.push(text));
    expect(button.textContent).toBe("Add new-name.ts:10-20 to message");
    await act(async () => button.click());
    expect(inserted).toEqual(["`src/new-name.ts:10-20`"]);
  });

  test("appearing and being pressed leave focus in the composer", async () => {
    const { composer, button } = await mount(() => {});
    composer.focus();
    expect(document.activeElement).toBe(composer);
    const kept = !button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(kept).toBe(true);
    expect(document.activeElement).toBe(composer);
  });
});
