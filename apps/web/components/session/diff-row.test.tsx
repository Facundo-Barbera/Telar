/**
 * WHAT AN OPENED ROW SAYS ABOUT A PATCH IT DID NOT FULLY GET — issue #694.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A MOUNTED ROW, NOT A STATIC RENDER, because the patch arrives in an EFFECT.
 * `renderToStaticMarkup` never runs one, so `diff-unknown.test.tsx`'s split —
 * hand the component its answer and read the markup — cannot reach any of the
 * states below. These mount into happy-dom and let the row fetch.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE VIEWER IS DETECTED BY ITS HOST, not by its content: `@pierre/diffs` draws
 * into a shadow root (see `diff-code-view.test.tsx`), so "are there hunks on
 * screen" is asked as "did the adapter mount" — `.diff-code-view` is the class
 * the app themes it through and the one thing visible from outside the boundary.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitFileChange, GitFilePatch } from "@telar/engine-client";
import { ReviewFileRow } from "./diff-surface";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

/** See the note in `diff-code-view.test.tsx`: the registration is process-wide
 *  and it is the NEXT file to register that dies without this. */
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const HUNKS = `diff --git a/big.txt b/big.txt
index 1111111..2222222 100644
--- a/big.txt
+++ b/big.txt
@@ -1,3 +1,3 @@
 const alpha = 1;
-const beta = 2;
+const beta = 3;
 const gamma = 4;
`;

/** Mounts one OPEN row over a fixed answer and hands back what it drew. */
async function row(
  patch: GitFilePatch,
  file: GitFileChange = { path: "big.txt", status: "modified" },
): Promise<{ text: string; viewers: number }> {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  roots.push(root);
  await act(async () => {
    root.render(<ReviewFileRow readPatch={() => Promise.resolve({ file: patch })} file={file} reported view={{ layout: "stacked", wrap: false, ignoreWhitespace: false }} open onToggle={() => {}} />);
  });
  // The effect resolves its promise a microtask later, and the viewer tokenises
  // asynchronously after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return { text: mount.textContent ?? "", viewers: mount.querySelectorAll(".diff-code-view").length };
}

describe("a row whose patch is not the whole patch (#694)", () => {
  test("a patch cut at the engine's bound says so AND still draws the hunks it got", async () => {
    /**
     * THE PAIR IS THE POINT, and each half alone is a different bug.
     *
     * Without the sentence the reader is shown a quarter of a change that looks
     * exactly like all of it — #654's defect wearing hunks instead of an empty
     * string. Without the viewer the fix would throw away a megabyte of correct,
     * readable hunks because the rest is missing, which is #650's mistake in the
     * other direction: what did arrive is kept.
     */
    const drawn = await row({ patch: HUNKS, binary: false, incomplete: "truncated" });
    expect(drawn.text).toContain("may not be the whole change");
    expect(drawn.viewers).toBe(1);
  });

  test("git not answering draws no viewer, because there is nothing behind the sentence", async () => {
    for (const [incomplete, says] of [
      ["timeout", "did not answer in time"],
      ["failed", "could not read"],
    ] as const) {
      const drawn = await row({ patch: "", binary: false, incomplete });
      expect(drawn.text, `${incomplete} says what happened`).toContain(says);
      expect(drawn.viewers, `${incomplete} draws no hunks`).toBe(0);
      // ...and never the sentence that belongs to the other state.
      expect(drawn.text).not.toContain("may not be the whole change");
    }
  });

  test("an ordinary patch says none of it and draws the viewer", async () => {
    // The anti-vacuity half: every assertion above has to be able to be absent.
    const drawn = await row({ patch: HUNKS, binary: false });
    expect(drawn.text).not.toContain("may not be the whole change");
    expect(drawn.text).not.toContain("could not read");
    expect(drawn.viewers).toBe(1);
  });
});
