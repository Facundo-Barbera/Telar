import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitFileChange, GitFilePatch } from "@telar/engine-client";
import { ReviewFileRow } from "./review-file-row";

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
        view={{ layout: "stacked", wrap: false, ignoreWhitespace: false, tree: true }}
        open
        onToggle={() => {}}
        {...(witness ? { witness } : {})}
      />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return { text: mount.textContent ?? "", viewers: mount.querySelectorAll(".diff-code-view").length, asked };
}

describe("a row whose patch is not the whole patch (#694)", () => {
  test("a patch cut at the engine's bound says so AND still draws the hunks it got", async () => {
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
      expect(drawn.text).not.toContain("may not be the whole change");
    }
  });

  test("an ordinary patch says none of it and draws the viewer", async () => {
    const drawn = await row({ patch: HUNKS, binary: false });
    expect(drawn.text).not.toContain("may not be the whole change");
    expect(drawn.text).not.toContain("could not read");
    expect(drawn.viewers).toBe(1);
  });

  test("a patch the parser choked on says so on the row — issue #694", async () => {
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
    expect(drawn.viewers).toBe(1);

    const clean = await row({ patch: HUNKS, binary: false });
    expect(clean.text).not.toContain("did not parse cleanly");
  });

  test("a renamed row asks for the patch with BOTH of its paths — issue #694", async () => {
    const drawn = await row({ patch: HUNKS, binary: false }, { path: "dst.txt", status: "renamed", renamedFrom: "src.txt" });
    expect(drawn.asked).toHaveLength(1);
    expect(drawn.asked[0]).toMatchObject({ path: "dst.txt", renamedFrom: "src.txt" });
    expect(drawn.text).toContain("Renamed from src.txt");
  });
});

describe("a patch with no hunks (#694)", () => {
  test("a mode-only change is a sentence, not an empty box", async () => {
    const drawn = await row({ patch: "diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n", binary: false }, { path: "m.sh", status: "modified" });
    expect(drawn.text).toContain("100644 → 100755");
    expect(drawn.text).toContain("No lines differ");
    expect(drawn.viewers).toBe(0);
    expect(drawn.text).not.toContain("did not parse cleanly");
  });

  test("a pure rename names both paths rather than drawing nothing", async () => {
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

describe("which witness a row names (#694)", () => {
  test("a turn's missing patch does not blame git", async () => {
    const journal = await row({ patch: "", binary: false, incomplete: "failed" }, { path: "a.ts", status: "modified" }, "journal");
    expect(journal.text).toContain("This turn reported writing this file without a patch");
    expect(journal.text).not.toContain("git");

    const git = await row({ patch: "", binary: false, incomplete: "failed" }, { path: "a.ts", status: "modified" }, "git");
    expect(git.text).toContain("git could not read this file's diff");
  });

  test("git is the default, because two of the three scopes are git", async () => {
    const unset = await row({ patch: "", binary: false, incomplete: "failed" });
    expect(unset.text).toContain("git could not read this file's diff");
  });
});
