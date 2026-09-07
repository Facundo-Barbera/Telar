/**
 * The real thing: a Telar venv built with uv, a kernel started through the
 * host, cells executed, images persisted, a notebook run and written back.
 * SKIPPED WHEN UV IS ABSENT — the unit of value here is the bridge and the
 * host working against a live ipykernel, which no stub can stand in for.
 * One venv per test file, cached under a temp dir; ~10s cold.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../src/state";
import { KernelHost } from "../src/ds/kernel-host";
import { ensureTelarVenv, telarVenvDir, telarVenvPython } from "../src/ds/telar-venv";
import { parseNotebook } from "../src/ds/notebook-file";

function hasUv(): boolean {
  try { execFileSync("uv", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

const skip = !hasUv() || process.env.TELAR_SKIP_KERNEL_TESTS === "1";

describe.skipIf(skip)("kernel host against a real ipykernel", () => {
  let root: string;
  let project: string;
  let store: EngineStore;
  let host: KernelHost;
  const states: string[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-kernel-"));
    project = path.join(root, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "data.csv"), "a,b\n1,x\n2,y\n3,z\n");
    store = new EngineStore(path.join(root, "engine"), Date.now);
    store.registerProject({ id: "project_k", name: "K", root: project });
    const base = execFileSync("uv", ["python", "find", "3.12"], { encoding: "utf8" }).trim();
    const venv = await ensureTelarVenv(telarVenvDir(store.paths.root, "project_k"), { basePython: base, stack: true });
    if (!venv.ok) throw new Error(venv.reason);
    store.updateProject("project_k", { dataScience: { enabled: true, python: { source: "telar", path: venv.python, resolvedAt: 1 } } });
    host = new KernelHost({
      engineRoot: store.paths.root,
      sessionDir: (id) => path.join(store.paths.sessions, id),
      events: {
        onState: (sessionId, state, reason) => { states.push(state); store.recordKernelState(sessionId, state, reason); },
        persistImage: (sessionId, input) => store.putAttachment(sessionId, { name: "plot.png", mediaType: input.mediaType, data: input.data, tags: ["plot"], producer: input.producer }).id,
      },
    });
    store.attachKernels(host);
    store.createSession({ id: "session_k", projectId: "project_k" });
  }, 300_000);

  afterAll(async () => {
    await host?.disposeAll("test over");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("the claim carries dataScience, and the venv python is the one resolved", () => {
    store.submitTurn("session_k", { runId: "run_1", input: "hi" });
    const claim = store.claimNextTurn("worker_1");
    expect(claim?.dataScience?.pythonPath).toBe(telarVenvPython(telarVenvDir(store.paths.root, "project_k")));
    store.stopTurn("session_k", "run_1");
  });

  test("execute prints, returns a dataframe preview, persists a plot, and journals outputs", async () => {
    const ds = store.dataScience("session_k");
    const hello = await ds.execute({ code: "print('hello'); x = 41" });
    expect(hello.ok).toBe(true);
    expect(hello.outputs[0]).toMatchObject({ kind: "text", stream: "stdout", text: "hello\n" });

    const df = await ds.execute({ code: "import pandas as pd\ndf = pd.read_csv('data.csv')\ndf" });
    expect(df.outputs.at(-1)).toMatchObject({ kind: "dataframe", shape: [3, 2], columns: ["a", "b"] });

    const plot = await ds.plot({ code: "import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()" });
    expect(plot.ok).toBe(true);
    expect(plot.attachmentId).toMatch(/^att_/);
    const plots = store.listAttachments("session_k", { tag: "plot" });
    expect(plots).toHaveLength(1);
    expect(plots[0]!.mediaType).toBe("image/png");
    expect(store.attachmentBytes("session_k", plots[0]!.id).data.byteLength).toBeGreaterThan(1000);

    const events = store.readEvents("session_k");
    expect(events.some((e) => e.type === "kernel.state.changed")).toBe(true);
    const outputs = events.filter((e) => e.type === "notebook.cell.output");
    expect(outputs.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(outputs)).not.toContain("dataB64");

    const vars = await ds.vars();
    expect(vars.map((v) => v.name).sort()).toEqual(["df", "x"]);
    const inspected = await ds.inspect("df");
    expect(inspected).toMatchObject({ found: true, shape: [3, 2] });
  }, 120_000);

  test("an error result carries a plain traceback and a watch violation is journaled", async () => {
    const ds = store.dataScience("session_k");
    const bad = await ds.execute({ code: "1/0" });
    expect(bad.ok).toBe(false);
    expect(bad.error?.ename).toBe("ZeroDivisionError");
    expect(bad.error?.traceback.join("")).not.toContain("[");

    await ds.watch({ name: "rows", assert: "df.shape[0] > 10" });
    const watches = await ds.watches();
    expect(watches[0]!.lastResult?.ok).toBe(false);
    expect(store.readEvents("session_k").some((e) => e.type === "ds.watch.violated")).toBe(true);
    await ds.watch({ name: "rows", remove: true });
  }, 60_000);

  test("snapshot, diff, checkpoint and restart round-trip the namespace", async () => {
    const ds = store.dataScience("session_k");
    await ds.snapshot("before");
    await ds.execute({ code: "df = df[df.a > 1]" });
    await ds.snapshot("after");
    const diff = await ds.diff("before", "after");
    expect(diff.changed.find((c) => c.name === "df")?.what[0]).toBe("shape 3×2 → 2×2");

    const saved = await ds.checkpoint({ action: "save", name: "cp" }) as { saved: string[] };
    expect(saved.saved).toContain("df");
    await ds.restart();
    expect(await ds.vars()).toEqual([]);
    await ds.checkpoint({ action: "restore", name: "cp" });
    expect((await ds.vars()).map((v) => v.name)).toContain("df");
  }, 120_000);

  test("a notebook is created, edited, run, and written back with outputs", async () => {
    const ds = store.dataScience("session_k");
    const created = await ds.notebookEdit("nb/test.ipynb", { kind: "create" });
    expect(created.cellCount).toBe(1);
    const edited = await ds.notebookEdit("nb/test.ipynb", { kind: "set", index: 0, source: "total = 2 + 2\ntotal" });
    await ds.notebookEdit("nb/test.ipynb", { kind: "insert", after: edited.cells[0]!.id, source: "raise ValueError('stop')" });
    await ds.notebookEdit("nb/test.ipynb", { kind: "insert", after: 1, source: "print('never')" });
    const { results } = await ds.notebookRun("nb/test.ipynb", { all: true });
    expect(results.map((r) => r.result.ok)).toEqual([true, false]);
    const onDisk = parseNotebook(fs.readFileSync(path.join(project, "nb/test.ipynb"), "utf8"));
    expect(onDisk.cells[0]!.execution_count).toBeGreaterThan(0);
    expect((onDisk.cells[0]!.outputs as { output_type: string }[])[0]!.output_type).toBe("execute_result");
    expect((onDisk.cells[1]!.outputs as { output_type: string }[])[0]!.output_type).toBe("error");
    expect(onDisk.cells[2]!.outputs).toEqual([]);
    const table = await store.sessionTable("session_k", "data.csv", { offset: 0, limit: 10 });
    expect(table.total).toBe(3);
    expect(table.rows[0]).toEqual([1, "x"]);
  }, 120_000);

  test("archiving the session kills its kernel", async () => {
    expect(host.info("session_k")?.state).not.toBe("dead");
    store.archiveSession("session_k");
    await new Promise((r) => setTimeout(r, 1500));
    expect(host.info("session_k")).toBeUndefined();
    expect(states).toContain("dead");
  }, 30_000);
});
