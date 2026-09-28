/**
 * THE DIFF SURFACE'S FILE TREE — issue #855.
 *
 * Ordering and chain collapse belong to `lib/file-tree.ts` and are pinned there;
 * what is pinned here is what the review adds on top: folding, and the claim
 * that the tree has no open set of its own — clicking a file opens the SAME row
 * the list draws, through the same toggle.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitFileChange, GitFilePatch } from "@telar/engine-client";
import { DEFAULT_DIFF_VIEW } from "../hooks/use-diff-view";
import { DiffFileTree, diffTreeRows } from "./diff-file-tree";
import { ReviewFileRow, toggleOpen } from "./diff-surface";

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

const names = (paths: string[], folded: string[] = []) => diffTreeRows(paths, new Set(folded)).map((row) => `${row.depth}:${row.node.name}`);

describe("the review's tree", () => {
  test("directories first, natural order, single-child chains collapsed, everything open", () => {
    expect(names(["README.md", "apps/web/lib/step-10.ts", "apps/web/lib/step-2.ts", "apps/engine/src/git.ts", "b.ts"])).toEqual([
      "0:apps",
      "1:engine/src",
      "2:git.ts",
      "1:web/lib",
      "2:step-2.ts",
      "2:step-10.ts",
      "0:b.ts",
      "0:README.md",
    ]);
  });

  test("a folded directory hides its contents and nothing else", () => {
    expect(names(["apps/web/a.ts", "apps/web/b.ts", "apps/engine/c.ts"], ["apps/web"])).toEqual(["0:apps", "1:engine", "2:c.ts", "1:web"]);
  });
});

const file = (path: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({ path, status: "modified", linesAdded: 1, linesRemoved: 0, ...extra });
const readPatch = () => new Promise<{ file: GitFilePatch }>(() => {});

/** The surface's own shape, reduced to the part under test: one set, one
 *  toggle, handed to both the tree and the rows. */
function Harness({ files }: { files: GitFileChange[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) => setOpen((current) => toggleOpen(current, path));
  return (
    <>
      <DiffFileTree files={files} openPaths={open} onSelect={toggle} />
      {files.map((row) => (
        <ReviewFileRow
          key={row.path}
          readPatch={readPatch}
          file={row}
          reported
          view={DEFAULT_DIFF_VIEW}
          open={open.has(row.path)}
          onToggle={() => toggle(row.path)}
        />
      ))}
    </>
  );
}

async function mount(files: GitFileChange[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Harness files={files} />));
  return host;
}

const treeItem = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find((item) => item.textContent?.includes(name))!;
const rowButton = (host: HTMLElement, path: string) => host.querySelector<HTMLButtonElement>(`[data-diff-path="${path}"] button[aria-expanded]`)!;

describe("the tree drives the rows' open set", () => {
  test("clicking a file opens its row, and the row's own chevron closes it in the tree", async () => {
    const host = await mount([file("src/a.ts"), file("src/b.ts")]);
    await act(async () => treeItem(host, "a.ts").click());
    expect(rowButton(host, "src/a.ts").getAttribute("aria-expanded")).toBe("true");
    expect(treeItem(host, "a.ts").getAttribute("aria-selected")).toBe("true");
    expect(rowButton(host, "src/b.ts").getAttribute("aria-expanded")).toBe("false");

    await act(async () => rowButton(host, "src/a.ts").click());
    expect(treeItem(host, "a.ts").getAttribute("aria-selected")).toBe("false");
  });

  test("clicking a directory folds it without touching any row", async () => {
    const host = await mount([file("src/a.ts"), file("src/b.ts")]);
    await act(async () => treeItem(host, "src").click());
    expect(host.querySelectorAll('[role="treeitem"]').length).toBe(1);
    expect(rowButton(host, "src/a.ts").getAttribute("aria-expanded")).toBe("false");
  });

  test("a renamed file sits at its new path and says where it came from", async () => {
    const host = await mount([file("new/name.ts", { status: "renamed", renamedFrom: "old/name.ts" }), file("new/other.ts")]);
    expect(treeItem(host, "name.ts").getAttribute("title")).toBe("old/name.ts → new/name.ts");
  });
});
