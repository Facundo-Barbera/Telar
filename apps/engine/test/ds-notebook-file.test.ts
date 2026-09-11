import { expect, test } from "bun:test";
import { emptyNotebook, findCell, fromNbOutputs, moveCell, parseNotebook, serializeNotebook, toNbOutputs } from "../src/ds/notebook-file";
import { diffSnapshots } from "../src/ds/store-capability";
import { namesIn } from "../src/ds/state-files";
import { parseDelimited, windowCsv } from "../src/ds/table";

const FIXTURE = {
  cells: [
    { cell_type: "markdown", metadata: { vscode: { languageId: "markdown" } }, source: ["# Hello\n", "world"] },
    { cell_type: "code", execution_count: 2, metadata: { tags: ["keep"] }, outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }], source: "print('hi')" },
  ],
  metadata: { kernelspec: { name: "python3" }, custom_vendor_key: { a: 1 } },
  nbformat: 4,
  nbformat_minor: 4,
  top_level_vendor: true,
};

test("a notebook round-trips with every unknown key kept and ids minted for cells that lack them", () => {
  const nb = parseNotebook(JSON.stringify(FIXTURE));
  expect(nb.cells).toHaveLength(2);
  expect(nb.cells[0]!.id).toMatch(/^[0-9a-f]{8}$/);
  expect(nb.cells[0]!.source).toBe("# Hello\nworld");
  expect(nb.cells[1]!.metadata).toEqual({ tags: ["keep"] });
  expect(nb.nbformat_minor).toBe(5);
  expect(nb.top_level_vendor).toBe(true);
  expect((nb.metadata as { custom_vendor_key: unknown }).custom_vendor_key).toEqual({ a: 1 });

  const text = serializeNotebook(nb);
  expect(text.endsWith("\n")).toBe(true);
  expect(text.startsWith("{\n \"cells\"")).toBe(true);
  const again = parseNotebook(text);
  expect(again.cells.map((c) => c.id)).toEqual(nb.cells.map((c) => c.id));
  expect(again.cells[0]!.source).toBe("# Hello\nworld");
  expect((again as { top_level_vendor?: boolean }).top_level_vendor).toBe(true);
});

test("an unchanged nbformat-4.5 notebook serializes byte-identical", () => {
  const nb = emptyNotebook();
  const once = serializeNotebook(nb);
  expect(serializeNotebook(parseNotebook(once))).toBe(once);
});

test("outputs translate both ways, and an image keeps its attachment id", () => {
  const nbOutputs = toNbOutputs(
    [
      { kind: "text", stream: "stdout", text: "a\nb\n" },
      { kind: "text", stream: "result", text: "42" },
      { kind: "image", mediaType: "image/png", attachmentId: "att_9" },
      { kind: "error", ename: "E", evalue: "v", traceback: ["t"] },
    ],
    (id) => (id === "att_9" ? "iVBORw0KGgo=" : undefined),
  );
  expect(nbOutputs).toHaveLength(4);
  const back = fromNbOutputs(nbOutputs);
  expect(back[0]).toEqual({ kind: "text", stream: "stdout", text: "a\nb\n" });
  expect(back[1]).toEqual({ kind: "text", stream: "result", text: "42" });
  expect(back[2]).toMatchObject({ kind: "image", mediaType: "image/png", attachmentId: "att_9", dataB64: "iVBORw0KGgo=" });
  expect(back[3]).toMatchObject({ kind: "error", ename: "E" });
});

test("findCell addresses by id or index and refuses the rest", () => {
  const nb = parseNotebook(JSON.stringify(FIXTURE));
  expect(findCell(nb, { cellId: nb.cells[1]!.id })).toBe(1);
  expect(findCell(nb, { index: 0 })).toBe(0);
  expect(() => findCell(nb, { index: 9 })).toThrow(/out of range/);
  expect(() => findCell(nb, {})).toThrow(/id or index/);
});

/**
 * MOVE KEEPS THE RECORD OF WHAT RAN. The reason the engine owns a `move` at
 * all is that a client faking one as delete-then-insert mints a new id and
 * loses `outputs` and `execution_count` — so these cases assert the cell comes
 * out the other side as the same object, not merely the same text.
 */
test("a cell moves down and up carrying its outputs, execution count and metadata", () => {
  const nb = parseNotebook(JSON.stringify(FIXTURE));
  const [markdown, code] = [nb.cells[0]!, nb.cells[1]!];

  // DOWN is the same verb as up: `to` is where it lands, either way.
  moveCell(nb, 0, 1);
  expect(nb.cells.map((c) => c.id)).toEqual([code.id, markdown.id]);

  moveCell(nb, 1, 0);
  expect(nb.cells.map((c) => c.id)).toEqual([markdown.id, code.id]);

  // The same object, not a copy — which is what makes the outputs survive.
  expect(nb.cells[1]).toBe(code);
  expect(nb.cells[1]!.execution_count).toBe(2);
  expect(nb.cells[1]!.outputs).toEqual([{ output_type: "stream", name: "stdout", text: ["hi\n"] }]);
  expect(nb.cells[1]!.metadata).toEqual({ tags: ["keep"] });
});

test("moving a cell to the index it already holds leaves the file byte-identical", () => {
  const nb = parseNotebook(JSON.stringify(FIXTURE));
  const before = serializeNotebook(nb);
  moveCell(nb, 1, 1);
  expect(nb.cells.map((c) => c.id)).toEqual(parseNotebook(before).cells.map((c) => c.id));
  expect(serializeNotebook(nb)).toBe(before);
});

test("a move target outside the notebook is refused rather than clamped", () => {
  const nb = parseNotebook(JSON.stringify(FIXTURE));
  expect(() => moveCell(nb, 0, 2)).toThrow(/out of range \(0\.\.1\)/);
  expect(() => moveCell(nb, 0, -1)).toThrow(/out of range/);
  expect(() => moveCell(nb, 0, 0.5)).toThrow(/out of range/);
  // Refused means UNCHANGED: a rejected move must not leave a hole behind.
  expect(nb.cells).toHaveLength(2);
});

test("nbformat other than 4 and non-JSON are refused", () => {
  expect(() => parseNotebook("{")).toThrow(/JSON/);
  expect(() => parseNotebook(JSON.stringify({ nbformat: 3, cells: [] }))).toThrow(/nbformat 3/);
});

test("snapshot diff names what moved", () => {
  const a = { name: "a", at: 1, vars: { df: { type: "pandas.DataFrame", shape: [3, 2], columns: ["x", "y"], dtypes: ["int64", "str"], nulls: { x: 0, y: 0 }, digest: "1" }, n: { type: "int", repr: "1" } } };
  const b = { name: "b", at: 2, vars: { df: { type: "pandas.DataFrame", shape: [2, 3], columns: ["x", "y", "z"], dtypes: ["float64", "str", "int64"], nulls: { x: 1, y: 0, z: 0 }, digest: "2" }, m: { type: "int", repr: "2" } } };
  const diff = diffSnapshots(a, b, "a", "b");
  expect(diff.added).toEqual(["m"]);
  expect(diff.removed).toEqual(["n"]);
  expect(diff.changed[0]!.what).toEqual(["shape 3×2 → 2×3", "columns +z", "x: int64 → float64", "x nulls 0 → 1"]);
  expect(() => diffSnapshots(undefined, b, "nope", "b")).toThrow(/no snapshot named nope/);
});

test("lineage name extraction sees assignments, imports, defs and reads", () => {
  const { assigned, read } = namesIn("import pandas as pd\ndf = pd.read_csv('x.csv')\ndf2, k = df.head(), 3\ndef f(a):\n    return a\nplt.plot(df2)");
  expect(assigned.sort()).toEqual(["df", "df2", "f", "k", "pd"]);
  expect(read).toContain("plt");
  expect(read).not.toContain("df");
});

test("the CSV parser handles quotes, embedded newlines, and windows a sorted view", () => {
  const rows = parseDelimited('a,b\n1,"x, y"\n2,"line\nbreak"\n3,""\n', ",");
  expect(rows).toEqual([["a", "b"], ["1", "x, y"], ["2", "line\nbreak"], ["3", ""]]);
  const window = windowCsv("n,s\n3,c\n1,a\n2,b\n", ",", { offset: 0, limit: 2, sort: "n" });
  expect(window.dtypes).toEqual(["number", "string"]);
  expect(window.total).toBe(3);
  expect(window.rows).toEqual([[1, "a"], [2, "b"]]);
  const desc = windowCsv("n,s\n3,c\n1,a\n2,b\n", ",", { offset: 1, limit: 5, sort: "n", desc: true });
  expect(desc.rows).toEqual([[2, "b"], [1, "a"]]);
});
