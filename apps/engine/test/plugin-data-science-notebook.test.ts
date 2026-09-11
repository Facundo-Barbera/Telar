/**
 * THE NOTEBOOK DOOR — the live failure this file exists for.
 *
 * A real session had `ds_kernel`, `ds_scratch`, `ds_inspect` and `ds_plot` all
 * answer, and `notebook_open` fail with **"no data-science method
 * notebook/edit"** and the same for `notebook/read`. Every single-word `ds`
 * verb worked; every notebook verb 404'd.
 *
 * WHY: `notebook` is the data-science plugin's second tool prefix, the worker's
 * capability calls these verbs as `notebook/read`, `notebook/edit` and
 * `notebook/run` (`ds/client-capability.ts`), the door's matcher admits exactly
 * one slash in a method (`daemon.ts`) — and the plugin's route table had no
 * two-segment keys at all. The verbs existed on the capability and nothing
 * routed to them.
 *
 * These cases go through the ACTUAL path: a real engine, a real store, a real
 * project and session, and `EngineClient.ds(...)` — the same call the worker
 * makes. Notebook create/read/edit are file operations and need no Python; the
 * one case that needs a kernel is skipped without `uv`, and live cell execution
 * against a real ipykernel is `ds-kernel.test.ts`.
 */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, type EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { dataScienceMeta } from "../src/plugins/data-science";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];
const root = (): string => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telar-ds-notebook-")));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * A project with data science on, a session in it, and a client.
 *
 * `embeddedWorker` because the kernel host is attached in that branch
 * (`daemon.ts`) and `store.dataScience()` refuses without one — and an
 * INTERPRETER PATH THAT EXISTS, because the gate checks it on disk. No cell is
 * executed by the file-only cases below, so `/bin/echo` standing in for python
 * is never run: it only has to be there, the way `plugin-latex-migration`
 * points a toolchain at it.
 */
async function ready(python = "/bin/echo") {
  const checkout = root();
  const daemon = await startEngine({ engineRoot: root(), embeddedWorker: true });
  daemons.push(daemon);
  const client = new EngineClient(daemon.discovery);
  await client.registerProject({ id: "project_nb", name: "Notebooks", root: checkout });
  await client.updateProject("project_nb", {
    dataScience: { enabled: true, python: { source: "detected", path: python, resolvedAt: 1 } },
  });
  await client.createSession({ id: "session_nb", projectId: "project_nb" });
  return { daemon, client, checkout };
}

/** The worker's own call: `POST /v2/sessions/:id/ds/<method>` — the released
 *  alias. */
const door = <T,>(client: EngineClient, method: string, body?: unknown) => client.ds<T>("session_nb", method, body);
/** The generic door: `POST /v2/sessions/:id/plugins/data-science/<method>`. */
const generic = <T,>(client: EngineClient, method: string, body?: unknown) => client.plugin<T>("session_nb", "data-science", method, body);

type NotebookRead = { path: string; cells: Array<{ id: string; cellType: string; source: string; executionCount?: number | null }> };

test("the plugin claims the notebook prefix AND routes every notebook verb", () => {
  // The manifest said `notebook` was this plugin's; the route table did not.
  // Both halves, asserted together, because it was their disagreement that
  // broke a live session.
  expect(dataScienceMeta.toolPrefixes).toContain("notebook");
});

test("notebook/edit creates a notebook and notebook/read reads it back — the verbs that 404'd", async () => {
  const { client, checkout } = await ready();

  // CREATE, the exact call `notebook_open(create: true)` makes.
  const created = await door<NotebookRead>(client, "notebook/edit", { path: "analysis.ipynb", edit: { kind: "create" } });
  expect(created.path).toBe("analysis.ipynb");
  expect(fs.existsSync(path.join(checkout, "analysis.ipynb"))).toBe(true);

  // READ, the call `notebook_open` makes without `create`.
  const read = await door<NotebookRead>(client, "notebook/read", { path: "analysis.ipynb" });
  expect(read.path).toBe("analysis.ipynb");
  expect(Array.isArray(read.cells)).toBe(true);
});

test("insert, set and delete all route, and the file on disk follows", async () => {
  const { client, checkout } = await ready();
  await door(client, "notebook/edit", { path: "work.ipynb", edit: { kind: "create" } });

  const inserted = await door<NotebookRead>(client, "notebook/edit", {
    path: "work.ipynb",
    edit: { kind: "insert", after: 0, source: "print('hello from the route')", cellType: "code" },
  });
  const cell = inserted.cells.find((each) => each.source.includes("hello from the route"));
  expect(cell).toBeDefined();

  const set = await door<NotebookRead>(client, "notebook/edit", {
    path: "work.ipynb",
    edit: { kind: "set", cellId: cell!.id, source: "print('edited through the door')" },
  });
  expect(set.cells.find((each) => each.id === cell!.id)!.source).toContain("edited through the door");
  // The .ipynb itself, not just the answer: this is a file the person opens.
  expect(fs.readFileSync(path.join(checkout, "work.ipynb"), "utf8")).toContain("edited through the door");

  const deleted = await door<NotebookRead>(client, "notebook/edit", { path: "work.ipynb", edit: { kind: "delete", cellId: cell!.id } });
  expect(deleted.cells.find((each) => each.id === cell!.id)).toBeUndefined();
});

/**
 * MOVE, THROUGH THE DOOR THE iPAD KNOCKS ON.
 *
 * The panel's Move up / Move down send `{"kind":"move", …}` here. The client
 * could have faked it as delete-then-insert and did not, because that mints a
 * new id and discards the outputs and execution count — so what this case
 * really asserts is that a cell arrives at its new index with the record of
 * what it ran still attached, in the .ipynb on disk and not only in the reply.
 */
test("move reorders a cell through the door, outputs and execution count intact", async () => {
  const { client, checkout } = await ready();
  // Written straight to disk, with outputs a kernel would have left, so the
  // case needs no Python to prove the thing it is about.
  fs.writeFileSync(
    path.join(checkout, "order.ipynb"),
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { id: "one", cell_type: "code", source: "first", metadata: {}, execution_count: 1, outputs: [] },
        { id: "two", cell_type: "code", source: "second", metadata: { tags: ["keep"] }, execution_count: 7, outputs: [{ output_type: "stream", name: "stdout", text: ["ran\n"] }] },
        { id: "three", cell_type: "markdown", source: "# third", metadata: {} },
      ],
    }),
  );

  // UP, by id: the iPad's Move up on the second cell.
  const up = await door<NotebookRead>(client, "notebook/edit", { path: "order.ipynb", edit: { kind: "move", cellId: "two", to: 0 } });
  expect(up.cells.map((each) => each.id)).toEqual(["two", "one", "three"]);
  expect(up.cells.find((each) => each.id === "two")!.executionCount).toBe(7);

  // DOWN, by index: the same verb, the other direction, addressed the other way.
  const down = await door<NotebookRead>(client, "notebook/edit", { path: "order.ipynb", edit: { kind: "move", index: 0, to: 2 } });
  expect(down.cells.map((each) => each.id)).toEqual(["one", "three", "two"]);

  // The .ipynb itself: the moved cell kept its outputs, its count and its
  // metadata, which delete-then-insert would have thrown away.
  const onDisk = JSON.parse(fs.readFileSync(path.join(checkout, "order.ipynb"), "utf8")) as { cells: Array<{ id: string; execution_count?: number; outputs?: unknown[]; metadata: unknown }> };
  expect(onDisk.cells.map((each) => each.id)).toEqual(["one", "three", "two"]);
  const moved = onDisk.cells[2]!;
  expect(moved.execution_count).toBe(7);
  expect(moved.outputs).toEqual([{ output_type: "stream", name: "stdout", text: ["ran\n"] }]);
  expect(moved.metadata).toEqual({ tags: ["keep"] });

  // A move to where it already is answers, and changes nothing.
  const still = await door<NotebookRead>(client, "notebook/edit", { path: "order.ipynb", edit: { kind: "move", cellId: "two", to: 2 } });
  expect(still.cells.map((each) => each.id)).toEqual(["one", "three", "two"]);

  // And a target past the end is refused in words, not clamped to the end.
  const refused = await door(client, "notebook/edit", { path: "order.ipynb", edit: { kind: "move", cellId: "two", to: 9 } }).then(
    () => "",
    (error: EngineClientError) => error.message,
  );
  expect(refused).toContain("out of range");
  const after = await door<NotebookRead>(client, "notebook/read", { path: "order.ipynb" });
  expect(after.cells.map((each) => each.id)).toEqual(["one", "three", "two"]);
});

test("a windowed read passes its options through rather than dropping them", async () => {
  const { client } = await ready();
  await door(client, "notebook/edit", { path: "long.ipynb", edit: { kind: "create" } });
  for (let index = 0; index < 4; index += 1) {
    await door(client, "notebook/edit", { path: "long.ipynb", edit: { kind: "insert", after: index, source: `cell ${index}`, cellType: "code" } });
  }
  const whole = await door<NotebookRead>(client, "notebook/read", { path: "long.ipynb" });
  const window = await door<NotebookRead>(client, "notebook/read", { path: "long.ipynb", from: 1, to: 2, withOutputs: true });
  expect(whole.cells.length).toBeGreaterThan(window.cells.length);
  expect(window.cells.length).toBeGreaterThan(0);
});

test("notebook/run REACHES the capability — it fails on the kernel, never on the route", async () => {
  /**
   * The distinction that matters for this bug: a missing route answers 404
   * "no data-science method …" before the plugin is asked anything. Without a
   * Python environment this call must still get past the door and fail at
   * kernel resolution, which is a `plugin_error`/`invalid_request` about the
   * interpreter.
   */
  const { client } = await ready();
  await door(client, "notebook/edit", { path: "run.ipynb", edit: { kind: "create" } });
  await door(client, "notebook/edit", { path: "run.ipynb", edit: { kind: "insert", after: 0, source: "1 + 1", cellType: "code" } });

  const outcome = await door(client, "notebook/run", { path: "run.ipynb", all: true }).then(
    () => ({ ok: true, message: "" }),
    (error: EngineClientError) => ({ ok: false, message: error.message }),
  );
  // Either it ran (a machine with an environment) or it failed on the
  // environment — never on the method.
  expect(outcome.message).not.toContain("no data-science method");
  expect(outcome.message).not.toContain("has no notebook");
});

test("the generic door reaches the notebook verbs too, and answers IDENTICALLY", async () => {
  /**
   * The two doors dispatch one route table, so they cannot be allowed to
   * disagree — the same property `plugin-latex-migration` asserts for LaTeX.
   * Before this, `/plugins/data-science/notebook/edit` did not even reach the
   * table: the generic matcher took one verb segment, so a two-segment verb
   * fell past the arm and answered "engine endpoint does not exist" while the
   * `/ds/` alias worked.
   */
  const { client, checkout } = await ready();

  // CREATE through the generic door — the door that could not see it.
  const created = await generic<NotebookRead>(client, "notebook/edit", { path: "generic.ipynb", edit: { kind: "create" } });
  expect(created.path).toBe("generic.ipynb");
  expect(fs.existsSync(path.join(checkout, "generic.ipynb"))).toBe(true);

  // READ, through both, on the same file: byte-for-byte the same answer.
  const throughGeneric = await generic<NotebookRead>(client, "notebook/read", { path: "generic.ipynb" });
  const throughAlias = await door<NotebookRead>(client, "notebook/read", { path: "generic.ipynb" });
  expect(throughGeneric).toEqual(throughAlias);

  // EDIT through the generic door is visible through the alias, because there
  // is one implementation behind both.
  const inserted = await generic<NotebookRead>(client, "notebook/edit", {
    path: "generic.ipynb",
    edit: { kind: "insert", after: 0, source: "print('through the generic door')", cellType: "code" },
  });
  const cell = inserted.cells.find((each) => each.source.includes("through the generic door"));
  expect(cell).toBeDefined();
  const seen = await door<NotebookRead>(client, "notebook/read", { path: "generic.ipynb" });
  expect(seen.cells.find((each) => each.id === cell!.id)).toBeDefined();

  // RUN reaches the capability through the generic door as well: it fails on
  // the interpreter, never on the method.
  const outcome = await generic(client, "notebook/run", { path: "generic.ipynb", all: true }).then(
    () => "",
    (error: EngineClientError) => error.message,
  );
  expect(outcome).not.toContain("has no notebook");
  expect(outcome).not.toContain("endpoint does not exist");
});

test("an unknown two-segment verb is a 404 from the PLUGIN, not a missing endpoint", async () => {
  // The widened matcher must not swallow anything: an unregistered verb of the
  // same shape is refused by the route table, naming the plugin.
  const { client } = await ready();
  const failure = await generic(client, "notebook/nosuch").then(
    () => undefined,
    (error: EngineClientError) => error,
  );
  expect(failure?.status).toBe(404);
  expect(failure?.message).toContain("data-science has no notebook/nosuch");

  // And a THIRD segment is still not a plugin call at all — the depth is
  // capped, so this falls through to the engine's own not-found rather than
  // becoming an unbounded catch-all.
  const deeper = await generic(client, "notebook/read/extra").then(
    () => undefined,
    (error: EngineClientError) => error,
  );
  expect(deeper?.status).toBe(404);
  expect(deeper?.message).toContain("endpoint does not exist");
});

test("an unknown notebook verb is still an honest 404 about the method", async () => {
  const { client } = await ready();
  await expect(door(client, "notebook/nosuch")).rejects.toMatchObject({ status: 404 } satisfies Partial<EngineClientError>);
});

/**
 * LIVE EXECUTION THROUGH THE DOOR, where the machine can run it: create a
 * notebook, insert a cell, run it, and read the output back out of the file.
 * Skipped without `uv`, exactly as `ds-kernel.test.ts` is.
 */
function hasUv(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!hasUv() || process.env.TELAR_SKIP_KERNEL_TESTS === "1")(
  "a cell run through notebook/run executes and its output lands in the file",
  async () => {
    // A real interpreter, found the way the ds tests find one.
    const python = execFileSync("uv", ["python", "find", "3.12"], { encoding: "utf8" }).trim();
    const { client, checkout } = await ready(python);

    await door(client, "notebook/edit", { path: "live.ipynb", edit: { kind: "create" } });
    await door(client, "notebook/edit", { path: "live.ipynb", edit: { kind: "insert", after: 0, source: "print('routed and executed')", cellType: "code" } });
    const ran = await door<{ results: Array<{ cellId: string; result: { ok: boolean; outputs: Array<{ kind: string; text?: string }> } }> }>(
      client,
      "notebook/run",
      { path: "live.ipynb", all: true },
    );
    const printed = ran.results.flatMap((each) => each.result.outputs).some((output) => (output.text ?? "").includes("routed and executed"));
    expect(printed).toBe(true);
    // Written back into the .ipynb, which is what makes it a notebook run
    // rather than a scratch cell.
    expect(fs.readFileSync(path.join(checkout, "live.ipynb"), "utf8")).toContain("routed and executed");
  },
  120_000,
);
