// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  buildAreaTree,
  joinAreaPath,
  pathIsPrefixOf,
  renamePathPrefix,
  rollupCount,
  splitAreaPath,
} from "./spool-area-tree";

/**
 * `docs/spool-loops.md` §13.7: an area's name is a PATH, one string per
 * subject, and everything else — the nested tree, the rename arithmetic, the
 * rollup counts — is pure rendering computed from it. These are real unit
 * tests (not source-text assertions like `components/spool/idiom.test.ts`)
 * because the shape here is genuinely a pure function of its input: given a
 * list of entries and an accessor, does the tree it builds match what §13.7
 * describes.
 */
describe("splitAreaPath — the engine's own rule, restated for the web", () => {
  test("splits on \" / \", trims each segment, drops empties", () => {
    expect(splitAreaPath("Work / Focaltec")).toEqual(["Work", "Focaltec"]);
    expect(splitAreaPath("Work /  Focaltec  ")).toEqual(["Work", "Focaltec"]);
    expect(splitAreaPath("Work /  ")).toEqual(["Work"]);
    expect(splitAreaPath("  ")).toEqual([]);
    expect(splitAreaPath("")).toEqual([]);
  });

  test("a single-segment name round-trips through join", () => {
    expect(joinAreaPath(splitAreaPath("Personal"))).toBe("Personal");
    expect(joinAreaPath(splitAreaPath("Work / Focaltec"))).toBe("Work / Focaltec");
  });
});

describe("pathIsPrefixOf — segment-boundary, never a string prefix", () => {
  test("\"Work\" is a prefix of \"Work / Focaltec\"", () => {
    expect(pathIsPrefixOf(["Work"], ["Work", "Focaltec"])).toBe(true);
  });

  test("\"Work\" is NOT a prefix of \"Workshop\" — the segment-boundary law §13.7 names by hand", () => {
    expect(pathIsPrefixOf(["Work"], ["Workshop"])).toBe(false);
  });

  test("a path is its own prefix, but a longer path is never a prefix of a shorter one", () => {
    expect(pathIsPrefixOf(["Work"], ["Work"])).toBe(true);
    expect(pathIsPrefixOf(["Work", "Focaltec"], ["Work"])).toBe(false);
  });

  test("a partial segment match at any depth fails, not only at the root", () => {
    expect(pathIsPrefixOf(["Work", "Foc"], ["Work", "Focaltec"])).toBe(false);
  });
});

describe("renamePathPrefix — the container-rename's own arithmetic", () => {
  test("replaces a matched prefix and keeps the remainder", () => {
    expect(renamePathPrefix("Work / Focaltec", ["Work"], ["Personal", "Work"])).toBe("Personal / Work / Focaltec");
  });

  test("an area that does not sit under the prefix is returned untouched", () => {
    expect(renamePathPrefix("Workshop", ["Work"], ["Personal"])).toBe("Workshop");
    expect(renamePathPrefix("Personal", ["Work"], ["Team"])).toBe("Personal");
  });

  test("renaming a leaf to itself is a no-op", () => {
    expect(renamePathPrefix("Work", ["Work"], ["Work"])).toBe("Work");
  });
});

type Line = { subject: string; area?: string; needs: number };

describe("buildAreaTree — nested containers, alphabetical, never floating", () => {
  test("a flat area still builds a one-level tree, same as the old grouping", () => {
    const tree = buildAreaTree<Line>(
      [
        { subject: "b", area: "Personal", needs: 0 },
        { subject: "a", area: "Personal", needs: 1 },
      ],
      (l) => l.area,
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe("Personal");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].lines.map((l) => l.subject)).toEqual(["b", "a"]);
  });

  test("\"Work / Focaltec\" nests a Focaltec container inside a Work container", () => {
    const tree = buildAreaTree<Line>([{ subject: "invoice", area: "Work / Focaltec", needs: 0 }], (l) => l.area);
    expect(tree).toHaveLength(1);
    const work = tree[0];
    expect(work.label).toBe("Work");
    expect(work.depth).toBe(0);
    expect(work.lines).toHaveLength(0);
    expect(work.children).toHaveLength(1);
    const focaltec = work.children[0];
    expect(focaltec.label).toBe("Focaltec");
    expect(focaltec.key).toBe("Work / Focaltec");
    expect(focaltec.depth).toBe(1);
    expect(focaltec.lines.map((l) => l.subject)).toEqual(["invoice"]);
  });

  test("a subject filed directly on \"Work\" and another filed under \"Work / Focaltec\" share the same Work node", () => {
    const tree = buildAreaTree<Line>(
      [
        { subject: "roadmap", area: "Work", needs: 0 },
        { subject: "invoice", area: "Work / Focaltec", needs: 0 },
      ],
      (l) => l.area,
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].lines.map((l) => l.subject)).toEqual(["roadmap"]);
    expect(tree[0].children[0].lines.map((l) => l.subject)).toEqual(["invoice"]);
  });

  test("un-areaed entries collect under one ghost node, never rendered as their own top-level bare list", () => {
    const tree = buildAreaTree<Line>(
      [
        { subject: "stray", area: undefined, needs: 0 },
        { subject: "loose", area: undefined, needs: 0 },
      ],
      (l) => l.area,
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].ghost).toBe(true);
    expect(tree[0].label).toBe("No area yet");
    expect(tree[0].lines.map((l) => l.subject)).toEqual(["stray", "loose"]);
  });

  test("no un-areaed entries means no ghost node at all", () => {
    const tree = buildAreaTree<Line>([{ subject: "a", area: "Personal", needs: 0 }], (l) => l.area);
    expect(tree.some((n) => n.ghost)).toBe(false);
  });

  test("top-level nodes sort alphabetically, same law the old flat grouping followed", () => {
    const tree = buildAreaTree<Line>(
      [
        { subject: "a", area: "Zeta", needs: 0 },
        { subject: "b", area: "Alpha", needs: 0 },
      ],
      (l) => l.area,
    );
    expect(tree.map((n) => n.label)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("rollupCount — a container's own facts, computed from what sits beneath it", () => {
  test("sums subjects and needs across a whole subtree, not just a node's own lines", () => {
    const tree = buildAreaTree<Line>(
      [
        { subject: "roadmap", area: "Work", needs: 2 },
        { subject: "invoice", area: "Work / Focaltec", needs: 1 },
        { subject: "expenses", area: "Work / Focaltec", needs: 0 },
      ],
      (l) => l.area,
    );
    const work = tree[0];
    const rollup = rollupCount(work, (l) => l.needs);
    expect(rollup.subjects).toBe(3);
    expect(rollup.needs).toBe(3);
    // The nested node's OWN rollup is scoped to itself.
    const focaltec = work.children[0];
    expect(rollupCount(focaltec, (l) => l.needs)).toEqual({ subjects: 2, needs: 1 });
  });
});
