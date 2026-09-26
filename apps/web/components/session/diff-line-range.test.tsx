/**
 * SELECTED LINES INTO THE MESSAGE — issue #855.
 *
 * The selection itself is `@pierre/diffs`'s and draws into a shadow root that
 * happy-dom measures at 0×0, so it is not driven here. What Telar owns is pinned
 * instead: turning the library's range into a reference, and the button that
 * offers it — which must put the text in the message without taking focus from
 * somebody typing there.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toLineRange } from "./diff-code-view";
import { LineRangeAction } from "./diff-surface";

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
    // A mouse-down whose default is prevented is what stops a button taking
    // focus; `dispatchEvent` returns false exactly when it was.
    const kept = !button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(kept).toBe(true);
    expect(document.activeElement).toBe(composer);
  });
});
