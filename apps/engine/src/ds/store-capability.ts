/**
 * `DsCapability` over the daemon's own kernel host and files. THE ONE
 * IMPLEMENTATION OF EVERY RULE: the worker's copy is HTTP calls that land on
 * routes that call this; the cockpit's notebook panel calls the same routes.
 *
 * What lives here and not in the toolkits: the kernel's lazy start, the
 * notebook file's hash-fenced write-back, watch evaluation after every
 * execution, lineage recording, snapshot diffing. The walls only compose
 * sentences.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceFile, WorkspaceWriteResult, TurnAttachment, EngineEvent } from "@telar/engine-client";
import type { DsCapability, KernelStatus, NotebookEdit, NotebookRead, SnapshotDiff, VarRow } from "./capability";
import type { KernelHost } from "./kernel-host";
import { emptyNotebook, findCell, fromNbOutputs, mintCellId, parseNotebook, serializeNotebook, toNbOutputs, type Notebook } from "./notebook-file";
import { type CellOutput, type ExecResult, plainTraceback } from "./outputs";
import { preflightPython } from "./python-env";
import { ensureTelarVenv, removeTelarVenv, telarVenvPython } from "./telar-venv";
import { namesIn, type DsFiles, type Snapshot, type SnapshotVar, type Watch } from "./state-files";

/**
 * A NOTEBOOK IS BIGGER THAN A SOURCE FILE — a few plots in it and it passes
 * the workspace's 512 KB ceiling, which is sized for things a person edits in
 * a textarea. 32 MB is where nbformat itself starts to hurt.
 */
export const NOTEBOOK_MAX_BYTES = 32 * 1024 * 1024;

type JournalEntry = Omit<Extract<EngineEvent, { type: "notebook.cell.output" }>, "id" | "at" | "sessionId" | "runId">
  | Omit<Extract<EngineEvent, { type: "kernel.state.changed" }>, "id" | "at" | "sessionId" | "runId">
  | Omit<Extract<EngineEvent, { type: "ds.watch.violated" }>, "id" | "at" | "sessionId" | "runId">;

export type StoreDsDeps = {
  sessionId: string;
  cwd: string;
  /** The project's interpreter, resolved. */
  python: string;
  /** Telar's venv dir for this session's scope — where jupyter_client lives. */
  telarVenv: string;
  host: KernelHost;
  files: DsFiles;
  readFile: (target: string) => WorkspaceFile;
  writeFile: (target: string, text: string, expected: string) => WorkspaceWriteResult;
  putAttachment: (input: { name: string; mediaType: string; data: Uint8Array; tags?: string[]; producer?: string }) => TurnAttachment;
  attachmentBytes: (id: string) => Uint8Array;
  appendEvent: (event: JournalEntry) => void;
  now: () => number;
};

export function storeDsCapability(deps: StoreDsDeps): DsCapability {
  const { sessionId, host, files } = deps;

  /**
   * The bridge runs on Telar's venv; the kernel imports from the project's.
   *
   * TELAR'S VENV IS BUILT HERE, LAZILY, ON THE PROJECT'S INTERPRETER. A person
   * who picked `.venv/bin/python` should never be told to go build a second
   * environment they did not ask for — the bridge's two packages are Telar's
   * concern. Built (or rebuilt on an ABI mismatch) at first kernel start:
   * a few seconds with uv, once per project. When `deps.python` already IS
   * Telar's venv, this is a no-op.
   */
  async function ensure(): Promise<void> {
    if (host.info(sessionId)?.state && host.info(sessionId)!.state !== "dead") return;
    const probe = await preflightPython(deps.python, []);
    if (!probe.ok) throw new Error(`the project's interpreter is unusable: ${probe.reason}`);
    let bridgePython = telarVenvPython(deps.telarVenv);
    if (bridgePython) {
      const bridgeProbe = await preflightPython(bridgePython, []);
      const mismatch = bridgeProbe.ok && probe.versionInfo && bridgeProbe.versionInfo && (probe.versionInfo[0] !== bridgeProbe.versionInfo[0] || probe.versionInfo[1] !== bridgeProbe.versionInfo[1]);
      if (!bridgeProbe.ok || mismatch) {
        removeTelarVenv(deps.telarVenv);
        bridgePython = undefined;
      }
    }
    if (!bridgePython) {
      const built = await ensureTelarVenv(deps.telarVenv, { basePython: deps.python });
      if (!built.ok) throw new Error(`could not build the kernel's environment on ${deps.python}: ${built.reason}`);
      bridgePython = built.python;
    }
    await host.ensure({ sessionId, bridgePython, sitePackages: probe.sitePackages ?? [], cwd: deps.cwd });
  }

  async function run(input: { code: string; cellId?: string; timeoutMs?: number; producer?: string }): Promise<ExecResult> {
    await ensure();
    const result = await host.execute(sessionId, { code: input.code, ...(input.cellId ? { cellId: input.cellId } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
    if (result.error) result.error.traceback = plainTraceback(result.error.traceback);
    for (const output of result.outputs) if (output.kind === "error") output.traceback = plainTraceback(output.traceback);
    const producer = input.producer ?? input.cellId ?? "scratch";
    const names = namesIn(input.code);
    if (names.assigned.length || names.read.length) files.appendLineage({ at: deps.now(), producer, code: input.code.slice(0, 2000), assigned: names.assigned, read: names.read });
    for (const output of result.outputs) deps.appendEvent({ type: "notebook.cell.output", execId: result.execId, ...(input.cellId ? { cellId: input.cellId } : {}), producer, output });
    await evaluateWatches();
    return result;
  }

  async function evaluateWatches(): Promise<void> {
    const watches = files.watches();
    if (!watches.length) return;
    const checks = watches.map((w) => `try:\n    _r.append((${JSON.stringify(w.name)}, bool(${w.assert}), None))\nexcept Exception as _e:\n    _r.append((${JSON.stringify(w.name)}, False, f"{type(_e).__name__}: {_e}"))`).join("\n");
    const code = `import json as _tj\n_r = []\n${checks}\nprint("__TELAR_WATCH__" + _tj.dumps(_r))`;
    const result = await host.execute(sessionId, { code });
    const line = result.outputs.find((o): o is Extract<CellOutput, { kind: "text" }> => o.kind === "text" && o.text.includes("__TELAR_WATCH__"));
    if (!line) return;
    const parsed = JSON.parse(line.text.slice(line.text.indexOf("__TELAR_WATCH__") + "__TELAR_WATCH__".length).trim()) as [string, boolean, string | null][];
    const at = deps.now();
    for (const [name, okay, detail] of parsed) {
      const watch = watches.find((w) => w.name === name);
      if (!watch) continue;
      watch.lastResult = { ok: okay, at, ...(detail ? { detail } : {}) };
      if (!okay) deps.appendEvent({ type: "ds.watch.violated", watch: name, assert: watch.assert, ...(detail ? { detail } : {}) });
    }
    files.saveWatches(watches);
  }

  function readNotebook(target: string): { nb: Notebook; file: WorkspaceFile } {
    const file = deps.readFile(target);
    if (file.binary) throw new Error("that file is not text");
    if (file.truncated) throw new Error(`that notebook is ${Math.round(file.bytes / 1024 / 1024)} MB, larger than the ${Math.round(NOTEBOOK_MAX_BYTES / 1024 / 1024)} MB the engine reads`);
    try {
      return { nb: parseNotebook(file.text), file };
    } catch (error) {
      throw new Error(`could not parse the notebook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function writeNotebook(target: string, nb: Notebook, expected: string): WorkspaceFile {
    const outcome = deps.writeFile(target, serializeNotebook(nb), expected);
    if (!outcome.written) throw new Error(outcome.refusal === "conflict" ? "the notebook changed on disk since it was read; read it again" : `write refused: ${outcome.refusal}`);
    return outcome.file;
  }

  function summarise(target: string, nb: Notebook, sha256: string, options: { from?: number; to?: number; withOutputs?: boolean } = {}): NotebookRead {
    const from = options.from ?? 0;
    const to = options.to ?? nb.cells.length - 1;
    return {
      path: target,
      sha256,
      cellCount: nb.cells.length,
      cells: nb.cells.map((cell, index) => ({ cell, index })).filter(({ index }) => index >= from && index <= to).map(({ cell, index }) => ({
        id: cell.id,
        index,
        type: cell.cell_type,
        source: cell.source,
        ...(cell.cell_type === "code" ? { executionCount: cell.execution_count ?? null } : {}),
        ...(cell.cell_type === "code" && cell.outputs ? { outputs: options.withOutputs ? fromNbOutputs(cell.outputs).map(stripImageBytes) : fromNbOutputs(cell.outputs).map(stripImageBytes).slice(-1) } : {}),
      })),
    };
  }

  const stripImageBytes = (output: CellOutput): CellOutput => (output.kind === "image" && output.attachmentId ? { ...output, dataB64: undefined } : output);

  const imageBase64 = (attachmentId: string): string | undefined => {
    try { return Buffer.from(deps.attachmentBytes(attachmentId)).toString("base64"); } catch { return undefined; }
  };

  return {
    async kernel(): Promise<KernelStatus> {
      const info = host.info(sessionId);
      return { state: info?.state ?? "none", ...(info?.executionCount !== undefined ? { executionCount: info.executionCount } : {}), ...(info?.modules ? { modules: info.modules } : {}), python: deps.python };
    },
    execute: run,
    async interrupt() { await host.interrupt(sessionId); },
    async restart() { await ensure(); await host.restart(sessionId); },
    async vars(limit = 100): Promise<VarRow[]> {
      await ensure();
      return (await host.call<{ vars: VarRow[] }>(sessionId, "list_vars", { limit })).vars;
    },
    async inspect(name, depth = 10) {
      await ensure();
      return host.call<Record<string, unknown>>(sessionId, "inspect_var", { name, depth });
    },

    async notebookRead(target, options) {
      const { nb, file } = readNotebook(target);
      return summarise(target, nb, file.sha256, options);
    },
    async notebookEdit(target, edit: NotebookEdit) {
      if (edit.kind === "create") {
        let existing: WorkspaceFile | undefined;
        try { existing = deps.readFile(target); } catch { /* absent */ }
        if (existing) { const { nb } = readNotebook(target); return summarise(target, nb, existing.sha256); }
        const nb = emptyNotebook();
        const absolute = path.resolve(deps.cwd, target);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, serializeNotebook(nb), { flag: "wx" });
        const file = deps.readFile(target);
        return summarise(target, nb, file.sha256);
      }
      const { nb, file } = readNotebook(target);
      if (edit.kind === "set") {
        const at = findCell(nb, edit);
        const cell = nb.cells[at]!;
        if (edit.source !== undefined) cell.source = edit.source;
        if (edit.cellType && edit.cellType !== cell.cell_type) {
          cell.cell_type = edit.cellType;
          if (edit.cellType === "code") { cell.execution_count = null; cell.outputs = []; } else { delete cell.execution_count; delete cell.outputs; }
        }
      } else if (edit.kind === "insert") {
        const type = edit.cellType ?? "code";
        const cell = { id: mintCellId(), cell_type: type, source: edit.source, metadata: {}, ...(type === "code" ? { execution_count: null, outputs: [] } : {}) } as Notebook["cells"][number];
        const after = edit.after === undefined ? nb.cells.length - 1 : edit.after === -1 ? -1 : typeof edit.after === "number" ? findCell(nb, { index: edit.after }) : findCell(nb, { cellId: edit.after });
        nb.cells.splice(after + 1, 0, cell);
      } else if (edit.kind === "delete") {
        nb.cells.splice(findCell(nb, edit), 1);
      }
      const written = writeNotebook(target, nb, file.sha256);
      return summarise(target, nb, written.sha256);
    },
    async notebookRun(target, input) {
      const { nb, file } = readNotebook(target);
      const targets = input.all ? nb.cells.filter((c) => c.cell_type === "code") : [nb.cells[findCell(nb, { cellId: input.cellId })]!];
      const results: Array<{ cellId: string; result: ExecResult }> = [];
      let sha = file.sha256;
      for (const cell of targets) {
        if (cell.cell_type !== "code") throw new Error(`cell ${cell.id} is ${cell.cell_type}, not code`);
        const result = await run({ code: cell.source, cellId: cell.id, producer: target });
        cell.execution_count = result.executionCount;
        cell.outputs = toNbOutputs(result.outputs, imageBase64);
        // Write after EVERY cell so an interrupted run_all leaves the file
        // showing what ran, and a concurrent editor conflicts on the next cell
        // rather than losing the whole batch.
        const written = writeNotebook(target, nb, sha);
        sha = written.sha256;
        results.push({ cellId: cell.id, result });
        if (!result.ok && input.stopOnError !== false) break;
      }
      return { results, notebook: summarise(target, nb, sha) };
    },

    async plot(input) {
      const result = await run({ code: input.code, producer: "ds_plot" });
      const image = result.outputs.find((o): o is Extract<CellOutput, { kind: "image" }> => o.kind === "image");
      return { ok: result.ok, outputs: result.outputs.filter((o) => o.kind !== "image"), ...(image?.attachmentId ? { attachmentId: image.attachmentId } : {}), ...(result.error ? { error: `${result.error.ename}: ${result.error.evalue}` } : {}) };
    },

    async snapshot(name, vars) {
      await ensure();
      const { vars: captured } = await host.call<{ vars: Record<string, SnapshotVar> }>(sessionId, "snapshot", { names: vars ?? [] });
      const snapshot: Snapshot = { name, at: deps.now(), vars: captured };
      files.saveSnapshot(snapshot);
      return snapshot;
    },
    async snapshots() { return files.listSnapshots(); },
    async diff(from, to) { return diffSnapshots(files.readSnapshot(from), files.readSnapshot(to), from, to); },
    async checkpoint(input) {
      if (input.action === "list") return files.listCheckpoints();
      if (!input.name) throw new Error("name is required");
      await ensure();
      return host.call(sessionId, input.action === "save" ? "checkpoint" : "restore", { path: files.checkpointPath(input.name) });
    },
    async lineage(of) {
      const rows = files.lineage();
      return of ? rows.filter((r) => r.assigned.includes(of) || r.read.includes(of)) : rows.slice(-200);
    },
    async watches() { return files.watches(); },
    async watch(input) {
      const watches = files.watches().filter((w) => w.name !== input.name);
      if (input.remove) { files.saveWatches(watches); return watches; }
      if (!input.assert) return files.watches();
      const watch: Watch = { name: input.name, assert: input.assert, createdAt: deps.now() };
      watches.push(watch);
      files.saveWatches(watches);
      await ensure();
      await evaluateWatches();
      return files.watches();
    },
    async experiment(input) {
      const runs = files.experiments();
      if (input.action === "list") return runs;
      if (input.action === "start") {
        if (!input.name) throw new Error("name is required to start");
        runs.push({ name: input.name, startedAt: deps.now(), params: input.params ?? {}, metrics: [] });
      } else {
        const target = input.name ? runs.find((r) => r.name === input.name) : [...runs].reverse().find((r) => !r.endedAt);
        if (!target) throw new Error("no open experiment; start one");
        if (input.action === "log") target.metrics.push({ ...(input.metrics ?? {}), _at: deps.now() });
        else target.endedAt = deps.now();
      }
      files.saveExperiments(runs);
      return runs;
    },
  };
}

export function diffSnapshots(a: Snapshot | undefined, b: Snapshot | undefined, from: string, to: string): SnapshotDiff {
  if (!a) throw new Error(`no snapshot named ${from}`);
  if (!b) throw new Error(`no snapshot named ${to}`);
  const added = Object.keys(b.vars).filter((k) => !(k in a.vars));
  const removed = Object.keys(a.vars).filter((k) => !(k in b.vars));
  const changed: SnapshotDiff["changed"] = [];
  for (const name of Object.keys(a.vars).filter((k) => k in b.vars)) {
    const before: SnapshotVar = a.vars[name]!;
    const after: SnapshotVar = b.vars[name]!;
    const what: string[] = [];
    if (before.type !== after.type) what.push(`type ${before.type} → ${after.type}`);
    if (JSON.stringify(before.shape) !== JSON.stringify(after.shape)) what.push(`shape ${before.shape?.join("×")} → ${after.shape?.join("×")}`);
    if (before.len !== after.len) what.push(`len ${before.len} → ${after.len}`);
    if (JSON.stringify(before.columns) !== JSON.stringify(after.columns)) {
      const gone = (before.columns ?? []).filter((c) => !(after.columns ?? []).includes(c));
      const fresh = (after.columns ?? []).filter((c) => !(before.columns ?? []).includes(c));
      what.push(`columns${gone.length ? ` -${gone.join(",")}` : ""}${fresh.length ? ` +${fresh.join(",")}` : ""}`);
    }
    if (before.columns && after.columns && before.dtypes && after.dtypes) {
      for (let i = 0; i < after.columns.length; i++) {
        const col = after.columns[i]!;
        const j = before.columns.indexOf(col);
        if (j >= 0 && before.dtypes[j] !== after.dtypes[i]) what.push(`${col}: ${before.dtypes[j]} → ${after.dtypes[i]}`);
      }
    }
    for (const col of Object.keys(after.nulls ?? {})) {
      const x = before.nulls?.[col];
      const y = after.nulls?.[col];
      if (x !== undefined && y !== undefined && x !== y) what.push(`${col} nulls ${x} → ${y}`);
    }
    for (const col of Object.keys(after.stats ?? {})) {
      const x = before.stats?.[col];
      const y = after.stats?.[col];
      if (x && y && (x.mean !== y.mean || x.min !== y.min || x.max !== y.max)) what.push(`${col} stats moved (mean ${fmt(x.mean)} → ${fmt(y.mean)})`);
    }
    if (!what.length && before.digest && after.digest && before.digest !== after.digest) what.push("content changed");
    if (!what.length && before.repr !== after.repr && before.repr !== undefined) what.push(`value ${before.repr} → ${after.repr}`);
    if (what.length) changed.push({ name, before: before as Record<string, unknown>, after: after as Record<string, unknown>, what });
  }
  return { from, to, added, removed, changed };
}

const fmt = (n: number | null | undefined): string => (n === null || n === undefined ? "∅" : Number.isInteger(n) ? String(n) : n.toFixed(3));
