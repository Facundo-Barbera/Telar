import { expect, test } from "bun:test";
import { assertTelarToolNames } from "@telar/engine-client";
import type { DsCapability } from "../src/ds/capability";
import { dsTools } from "../src/ds/ds-tools";
import { notebookTools } from "../src/ds/notebook-tools";
import type { ToolFactory } from "../src/tool-kit";

type Registered = { name: string; description: string; shape: Record<string, unknown>; run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> };

function build(capability: Partial<DsCapability>): Registered[] {
  const tools: Registered[] = [];
  const factory: ToolFactory = (name, description, shape, handler) => {
    tools.push({ name, description, shape, run: handler });
    return { name };
  };
  const refuse = async () => { throw new Error("not in this test"); };
  const full = new Proxy({} as DsCapability, { get: (_, prop) => (capability as Record<string | symbol, unknown>)[prop] ?? refuse });
  notebookTools(factory, full);
  dsTools(factory, full);
  return tools;
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

test("every notebook_* and ds_* tool carries a declared capability prefix", () => {
  const names = build({}).map((t) => t.name);
  expect(names.length).toBeGreaterThan(15);
  expect(() => assertTelarToolNames(names)).not.toThrow();
  expect(names.some((n) => /accept|approve|merge/.test(n))).toBe(false);
});

test("ds_scratch renders outputs for the model and marks an error result", async () => {
  const tools = build({
    execute: async ({ code }) => ({
      execId: "exec_1",
      ok: !code.includes("boom"),
      executionCount: 3,
      outputs: [
        { kind: "text", stream: "stdout", text: "hello\n" },
        { kind: "dataframe", columns: ["a", "b"], dtypes: ["int64", "str"], rows: [[1, "x"]], shape: [1, 2], truncated: false },
        { kind: "image", mediaType: "image/png", attachmentId: "att_1" },
      ],
      ...(code.includes("boom") ? { error: { ename: "RuntimeError", evalue: "boom", traceback: [] } } : {}),
    }),
  });
  const scratch = tools.find((t) => t.name === "ds_scratch")!;
  const ok = await scratch.run({ code: "print(1)" });
  expect(ok.isError).toBeUndefined();
  expect(text(ok)).toContain("hello");
  expect(text(ok)).toContain("[dataframe 1×2]");
  expect(text(ok)).toContain("attachment:att_1");
  const bad = await scratch.run({ code: "boom" });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("RuntimeError: boom");
});

test("a tool gated on a missing library refuses in one sentence naming it", async () => {
  const tools = build({ kernel: async () => ({ state: "idle", modules: { pandas: true, duckdb: false, matplotlib: false } }) });
  const query = await tools.find((t) => t.name === "ds_query")!.run({ sql: "select 1" });
  expect(query.isError).toBe(true);
  expect(text(query)).toContain("duckdb is not importable");
  const plot = await tools.find((t) => t.name === "ds_plot")!.run({ of: "df" });
  expect(text(plot)).toContain("matplotlib is not importable");
});

test("notebook_open lists cells by id and notebook_edit_cell refuses an empty edit", async () => {
  const nb = { path: "a.ipynb", sha256: "abc", cellCount: 2, cells: [
    { id: "c1", index: 0, type: "markdown" as const, source: "# Title" },
    { id: "c2", index: 1, type: "code" as const, source: "x = 1\ny = 2", executionCount: 4, outputs: [{ kind: "error" as const, ename: "ValueError", evalue: "", traceback: [] }] },
  ] };
  const tools = build({ notebookRead: async () => nb });
  const open = await tools.find((t) => t.name === "notebook_open")!.run({ path: "a.ipynb" });
  expect(text(open)).toContain("c1");
  expect(text(open)).toContain("c2");
  expect(text(open)).toContain("[4]");
  expect(text(open)).toContain("→ error ValueError");
  const edit = await tools.find((t) => t.name === "notebook_edit_cell")!.run({ path: "a.ipynb", cellId: "c2" });
  expect(edit.isError).toBe(true);
});

test("notebook_edit_cell takes moveTo and hands the capability an absolute move", async () => {
  // The agent-facing half of the iPad's Move up / Move down: a model that can
  // insert and delete should be able to reorder without losing what ran.
  const edits: unknown[] = [];
  const tools = build({
    notebookEdit: async (_path, edit) => {
      edits.push(edit);
      return { path: "a.ipynb", sha256: "abc", cellCount: 1, cells: [{ id: "c1", index: 0, type: "code" as const, source: "x = 1" }] };
    },
  });
  const edit = tools.find((t) => t.name === "notebook_edit_cell")!;
  expect(edit.shape).toHaveProperty("moveTo");

  const moved = await edit.run({ path: "a.ipynb", cellId: "c2", moveTo: 0 });
  expect(moved.isError).toBeUndefined();
  expect(edits[0]).toEqual({ kind: "move", to: 0, cellId: "c2" });

  await edit.run({ path: "a.ipynb", index: 3, moveTo: 1 });
  expect(edits[1]).toEqual({ kind: "move", to: 1, index: 3 });

  // moveTo: 0 is a real edit, not a falsy "nothing to change".
  expect(edits).toHaveLength(2);
});

test("ds_diff reads 'now' as snapshot-then-compare and reports each change", async () => {
  const snapshots: string[] = [];
  const tools = build({
    snapshot: async (name) => { snapshots.push(name); return { name, at: 1, vars: {} }; },
    diff: async (from, to) => ({ from, to, added: ["z"], removed: [], changed: [{ name: "df", before: {}, after: {}, what: ["shape 3×2 → 2×2"] }] }),
  });
  const out = await tools.find((t) => t.name === "ds_diff")!.run({ from: "a", to: "now" });
  expect(snapshots).toEqual(["now"]);
  expect(text(out)).toBe("+ z\n~ df: shape 3×2 → 2×2");
});
