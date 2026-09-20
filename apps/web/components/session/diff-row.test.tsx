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
  witness?: "git" | "journal",
): Promise<{ text: string; viewers: number; asked: GitFileChange[] }> {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  roots.push(root);
  const asked: GitFileChange[] = [];
  const readPatch = (requested: GitFileChange) => {
    asked.push(requested);
    return Promise.resolve({ file: patch });
  };
  await act(async () => {
    root.render(
      <ReviewFileRow
        readPatch={readPatch}
        file={file}
        reported
        view={{ layout: "stacked", wrap: false, ignoreWhitespace: false }}
        open
        onToggle={() => {}}
        {...(witness ? { witness } : {})}
      />,
    );
  });
  // The effect resolves its promise a microtask later, and the viewer tokenises
  // asynchronously after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return { text: mount.textContent ?? "", viewers: mount.querySelectorAll(".diff-code-view").length, asked };
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

  test("a patch the parser choked on says so on the row — issue #694", async () => {
    /**
     * STEP 1 OF THE CORRECTNESS PASS, and the reason the rest is falsifiable.
     * `@pierre/diffs` never throws at Telar: it logs to a console nobody reads
     * and renders what it could recover. So a patch cut mid-hunk drew 24,642
     * lines of an 80,000-line change and looked entirely reasonable doing it.
     */
    const cut = `diff --git a/big.txt b/big.txt
index 1111111..2222222 100644
--- a/big.txt
+++ b/big.txt
@@ -1,9 +1,9 @@
 const alpha = 1;
-const beta = 2;
+const beta = 3;
-const gam`;
    const drawn = await row({ patch: cut, binary: false });
    expect(drawn.text).toContain("did not parse cleanly");
    // The recovery is still drawn under the warning — most of a patch beats an
    // empty box, as long as nobody is told it is all of it.
    expect(drawn.viewers).toBe(1);

    // BOTH DIRECTIONS ON THE SAME TEST: a well-formed patch must not wear the
    // band, or "there was a band" proves nothing at all.
    const clean = await row({ patch: HUNKS, binary: false });
    expect(clean.text).not.toContain("did not parse cleanly");
  });

  test("a renamed row asks for the patch with BOTH of its paths — issue #694", async () => {
    /**
     * The row is the only party that holds the pair: the LIST derived it with
     * `--find-renames`, and a patch read with the new path alone excludes the
     * old one from the pathspec, so git answers `new file mode` and the row's
     * own "Renamed from src.txt" label contradicts the hunks under it.
     */
    const drawn = await row({ patch: HUNKS, binary: false }, { path: "dst.txt", status: "renamed", renamedFrom: "src.txt" });
    expect(drawn.asked).toHaveLength(1);
    expect(drawn.asked[0]).toMatchObject({ path: "dst.txt", renamedFrom: "src.txt" });
    // And the row still says so in words, which is the claim the patch has to
    // agree with.
    expect(drawn.text).toContain("Renamed from src.txt");
  });
});

/**
 * A CHANGE WITH NO HUNKS IS STILL A CHANGE — issue #694, §2.3.
 *
 * The patch is non-empty, so the "No textual difference" branch never fires;
 * `binary` is false, so that one does not either; and the viewer's only place
 * to draw a mode is the file header Telar disables. The row expanded into
 * NOTHING: no lines, no explanation, no error, over a `chmod +x` that most
 * scaffolding runs produce.
 */
describe("a patch with no hunks (#694)", () => {
  test("a mode-only change is a sentence, not an empty box", async () => {
    const drawn = await row({ patch: "diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n", binary: false }, { path: "m.sh", status: "modified" });
    expect(drawn.text).toContain("100644 → 100755");
    expect(drawn.text).toContain("No lines differ");
    // The empty box this replaces: mounting the viewer over zero hunks is what
    // drew nothing at all.
    expect(drawn.viewers).toBe(0);
    // ...and it is not mistaken for a parse failure, which is the other way a
    // row could have got a sentence out of this patch.
    expect(drawn.text).not.toContain("did not parse cleanly");
  });

  test("a pure rename names both paths rather than drawing nothing", async () => {
    // The shape the engine's rename fix produces. Fixing that without this
    // would have turned one wrong answer into one blank one.
    const drawn = await row(
      { patch: "diff --git a/src.txt b/dst.txt\nsimilarity index 100%\nrename from src.txt\nrename to dst.txt\n", binary: false },
      { path: "dst.txt", status: "renamed", renamedFrom: "src.txt" },
    );
    expect(drawn.text).toContain("Moved from src.txt");
    expect(drawn.text).toContain("No lines differ");
    expect(drawn.viewers).toBe(0);
  });

  test("a patch WITH hunks still draws the viewer, so the sentence is a claim", async () => {
    const drawn = await row({ patch: HUNKS, binary: false });
    expect(drawn.text).not.toContain("No lines differ");
    expect(drawn.viewers).toBe(1);
  });
});

/**
 * THE SENTENCE NAMES THE PARTY THAT WAS ASKED — issue #694, step 3's other half.
 *
 * The turn scope never asks git: its patch is the agent's own, already in hand.
 * A row there that said "git could not read this file's diff" named a witness
 * that was never consulted — which is #690's defect in miniature, on the one
 * scope whose design point is that it says which witness it is.
 */
describe("which witness a row names (#694)", () => {
  test("a turn's missing patch does not blame git", async () => {
    const journal = await row({ patch: "", binary: false, incomplete: "failed" }, { path: "a.ts", status: "modified" }, "journal");
    expect(journal.text).toContain("This turn reported writing this file without a patch");
    expect(journal.text).not.toContain("git");

    // The same answer under the git scopes still names git, or the fix would be
    // a rename of one sentence rather than a distinction between two.
    const git = await row({ patch: "", binary: false, incomplete: "failed" }, { path: "a.ts", status: "modified" }, "git");
    expect(git.text).toContain("git could not read this file's diff");
  });

  test("git is the default, because two of the three scopes are git", async () => {
    const unset = await row({ patch: "", binary: false, incomplete: "failed" });
    expect(unset.text).toContain("git could not read this file's diff");
  });
});
