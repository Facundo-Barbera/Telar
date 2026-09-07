/**
 * `ds_*` — the analysis tools. Every one of them is a shaped call into the
 * session's kernel; the shapes exist so a model can ask "what is in df" or
 * "which rows" without composing pandas from scratch, and so the answer comes
 * back sized for a context window rather than as a repr of a million rows.
 *
 * GATED BY WHAT IMPORTS, NOT BY WHAT WAS INSTALLED. A tool whose library is
 * missing in this kernel still registers — a model should learn it exists and
 * why it will not work here — but its handler refuses in one sentence naming
 * the library, and `ds_kernel` says the same up front.
 */
import { z } from "zod";
import { err, failure, json, ok, type ToolFactory } from "../tool-kit";
import type { DsCapability } from "./capability";
import { describeOutputs } from "./outputs";

const NAME = z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe("A Python identifier in the kernel's namespace.");

/** Python source that, run in the kernel, evaluates `expr` and prints JSON. */
const py = (expr: string) => `import json as _tj\nprint(_tj.dumps(${expr}, default=str))`;

async function needs(capability: DsCapability, module: string): Promise<string | undefined> {
  const kernel = await capability.kernel();
  if (kernel.state === "none") return undefined; // starts on first use; probe then
  if (kernel.modules && kernel.modules[module] === false) return `${module} is not importable in this session's kernel. Enable the analysis stack in the project's Data science settings, or install it into the chosen interpreter.`;
  return undefined;
}

const resultText = (outputs: Parameters<typeof describeOutputs>[0]) => describeOutputs(outputs);

export function dsTools(tool: ToolFactory, capability: DsCapability): unknown[] {
  return [
    tool(
      "ds_kernel",
      "The session's kernel: its state, which analysis libraries import (pandas, matplotlib, duckdb, pyarrow, polars), and which interpreter. Cheap. Call it once before leaning on ds_query or ds_plot.",
      {},
      async () => {
        try {
          return json(await capability.kernel());
        } catch (error) {
          return err(`Could not read the kernel: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_scratch",
      "Run Python in the session's kernel and return what it printed, displayed or raised. State persists: a variable assigned here is there for the next call and for every notebook cell. This is the REPL — reach for it when no shaped tool fits. Output is capped; ask for less rather than more.",
      {
        code: z.string().min(1).describe("Python source. Multi-line is fine."),
        timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe("Interrupt the cell after this long. Default one hour."),
      },
      async (args) => {
        try {
          const result = await capability.execute({ code: String(args.code), producer: "ds_scratch", ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}) });
          const text = resultText(result.outputs);
          return result.ok ? ok(text || "(no output)") : err(`${result.error?.ename}: ${result.error?.evalue}\n${text}`);
        } catch (error) {
          return err(`Could not execute: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_inspect",
      "Describe a variable without printing it: type, shape, dtypes, null counts, memory, and the first rows. Works on dataframes, series, arrays, lists and dicts. Pass a FILE PATH instead of a name to describe a CSV, Parquet or JSON file without loading it into a variable.",
      {
        name: z.string().min(1).describe("A variable name, or a file path ending in .csv, .tsv, .parquet, .json or .jsonl."),
        depth: z.number().int().min(1).max(100).optional().describe("How many rows or items to show. Default 10."),
      },
      async (args) => {
        const name = String(args.name);
        const depth = typeof args.depth === "number" ? args.depth : 10;
        try {
          if (/\.(csv|tsv|parquet|json|jsonl)$/i.test(name)) {
            const gate = await needs(capability, "pandas");
            if (gate) return err(gate);
            const code = `import pandas as _pd, os as _os
_p = ${JSON.stringify(name)}
_ext = _os.path.splitext(_p)[1].lower()
_df = _pd.read_parquet(_p) if _ext == ".parquet" else _pd.read_json(_p, lines=_ext == ".jsonl") if _ext in (".json", ".jsonl") else _pd.read_csv(_p, sep="\\t" if _ext == ".tsv" else ",", nrows=200000)
${py(`{"path": _p, "bytes": _os.path.getsize(_p), "shape": list(_df.shape), "columns": list(map(str, _df.columns)), "dtypes": [str(_df.dtypes[c]) for c in _df.columns], "nulls": {str(c): int(v) for c, v in _df.isna().sum().items()}, "head": _df.head(${depth}).to_dict(orient="split"), "note": "shape counts at most 200000 rows for CSV" if _ext in (".csv", ".tsv") else None}`)}`;
            const result = await capability.execute({ code, producer: "ds_inspect" });
            if (!result.ok) return err(`${result.error?.ename}: ${result.error?.evalue}`);
            return ok(resultText(result.outputs));
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return err("Give a variable name or a data file path.");
          const info = await capability.inspect(name, depth);
          if (info.found === false) return err(`No variable named ${name} in the kernel. ds_vars lists what exists.`);
          return json(info);
        } catch (error) {
          return err(`Could not inspect ${name}: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_vars",
      "Every variable in the kernel with its type and size — the namespace at a glance. Modules, functions and classes are omitted.",
      { limit: z.number().int().min(1).max(500).optional().describe("Default 100.") },
      async (args) => {
        try {
          const rows = await capability.vars(typeof args.limit === "number" ? args.limit : 100);
          if (rows.length === 0) return ok("The namespace is empty.");
          return ok(rows.map((r) => `${r.name.padEnd(24)} ${r.type.padEnd(28)} ${r.shape ? `shape ${r.shape.join("×")}` : r.len !== undefined ? `len ${r.len}` : r.repr ?? ""}${r.sizeBytes ? `  ${human(r.sizeBytes)}` : ""}`).join("\n"));
        } catch (error) {
          return err(`Could not list variables: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_profile",
      "Per-column statistics for a dataframe: count, nulls, unique values, min/max/mean/quantiles for numbers, top values for strings, and pairwise correlations above 0.5. Requires pandas.",
      {
        name: NAME,
        columns: z.array(z.string()).optional().describe("Restrict to these columns."),
      },
      async (args) => {
        const gate = await needs(capability, "pandas");
        if (gate) return err(gate);
        const name = String(args.name);
        const cols = Array.isArray(args.columns) ? args.columns : undefined;
        const code = `import pandas as _pd, numpy as _np
_df = ${name}${cols ? `[${JSON.stringify(cols)}]` : ""}
_out = {"shape": list(_df.shape), "columns": {}}
for _c in _df.columns:
    _s = _df[_c]; _rec = {"dtype": str(_s.dtype), "count": int(_s.count()), "nulls": int(_s.isna().sum()), "unique": int(_s.nunique())}
    if _pd.api.types.is_numeric_dtype(_s) and not _pd.api.types.is_bool_dtype(_s):
        _q = _s.quantile([0, .25, .5, .75, 1]); _rec.update({"mean": float(_s.mean()), "std": float(_s.std()), "min": float(_q.iloc[0]), "p25": float(_q.iloc[1]), "median": float(_q.iloc[2]), "p75": float(_q.iloc[3]), "max": float(_q.iloc[4])})
    else:
        _rec["top"] = {str(k): int(v) for k, v in _s.value_counts(dropna=True).head(5).items()}
    _out["columns"][str(_c)] = _rec
_num = _df.select_dtypes(include="number")
if _num.shape[1] > 1:
    _corr = _num.corr(); _pairs = []
    for _i, _a in enumerate(_corr.columns):
        for _b in _corr.columns[_i+1:]:
            _v = _corr.loc[_a, _b]
            if _v == _v and abs(_v) >= 0.5: _pairs.append({"a": str(_a), "b": str(_b), "r": round(float(_v), 3)})
    _out["correlations"] = sorted(_pairs, key=lambda p: -abs(p["r"]))[:20]
${py("_out")}`;
        try {
          const result = await capability.execute({ code, producer: "ds_profile" });
          return result.ok ? ok(resultText(result.outputs)) : err(`${result.error?.ename}: ${result.error?.evalue}`);
        } catch (error) {
          return err(`Could not profile ${name}: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_plot",
      "Render a matplotlib figure and store it as a plot the human sees in the Plots panel. Either give `code` that draws with plt, or describe the chart (`of`, `kind`, `x`, `y`, `hue`) and one is composed. Returns the attachment id. Requires matplotlib.",
      {
        code: z.string().optional().describe("Python that draws a figure with matplotlib (plt.* or df.plot). Do not call plt.show()."),
        of: NAME.optional().describe("A dataframe to plot from, for the declarative form."),
        kind: z.enum(["line", "bar", "barh", "hist", "scatter", "box", "area", "pie"]).optional().describe("Chart kind for the declarative form. Default line."),
        x: z.string().optional(),
        y: z.union([z.string(), z.array(z.string())]).optional(),
        hue: z.string().optional().describe("Column to colour by (scatter and line)."),
        title: z.string().optional(),
      },
      async (args) => {
        const gate = await needs(capability, "matplotlib");
        if (gate) return err(gate);
        let code = typeof args.code === "string" ? args.code : "";
        if (!code) {
          if (typeof args.of !== "string") return err("Give `code`, or `of` with a chart description.");
          const kind = typeof args.kind === "string" ? args.kind : "line";
          const x = typeof args.x === "string" ? `x=${JSON.stringify(args.x)}, ` : "";
          const y = Array.isArray(args.y) ? `y=${JSON.stringify(args.y)}, ` : typeof args.y === "string" ? `y=${JSON.stringify(args.y)}, ` : "";
          const hue = typeof args.hue === "string" && kind === "scatter" ? `c=${JSON.stringify(args.hue)}, colormap="viridis", ` : "";
          code = `import matplotlib.pyplot as plt\n_ax = ${args.of}.plot(kind=${JSON.stringify(kind)}, ${x}${y}${hue}figsize=(9, 5))\n`;
        } else {
          code = `import matplotlib.pyplot as plt\n${code.replace(/^\s*plt\.show\(\)\s*$/gm, "")}\n`;
        }
        if (typeof args.title === "string") code += `plt.title(${JSON.stringify(args.title)})\n`;
        code += "plt.tight_layout()\nplt.show()\n";
        try {
          const outcome = await capability.plot({ code, ...(typeof args.title === "string" ? { title: args.title } : {}) });
          if (!outcome.ok) return err(`Plot failed: ${outcome.error ?? "unknown"}\n${resultText(outcome.outputs)}`);
          if (!outcome.attachmentId) return err(`The code ran but drew no figure.\n${resultText(outcome.outputs)}`);
          return json({ attachmentId: outcome.attachmentId, note: "Stored in the session's plots. Reference it by attachment id." });
        } catch (error) {
          return err(`Could not plot: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_query",
      "SQL over the kernel's dataframes and the session's files, through DuckDB. Any dataframe variable is a table by its name; a file is `read_csv_auto('path')` or `read_parquet('path')`. Results are capped at `limit` rows; pass `as` to store the full result as a new dataframe variable instead. Requires duckdb.",
      {
        sql: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional().describe("Rows to return. Default 50."),
        as: NAME.optional().describe("Store the full result in this variable and return only its shape."),
      },
      async (args) => {
        const gate = await needs(capability, "duckdb");
        if (gate) return err(gate);
        const limit = typeof args.limit === "number" ? args.limit : 50;
        const target = typeof args.as === "string" ? args.as : undefined;
        const code = `import duckdb as _duck
_con = duckdb.connect() if False else _duck.connect()
_res = _con.sql(${JSON.stringify(String(args.sql))}).df()
${target ? `${target} = _res\n${py(`{"stored": ${JSON.stringify(target)}, "shape": list(_res.shape), "columns": list(map(str, _res.columns))}`)}` : `_res.head(${limit})`}`;
        try {
          const result = await capability.execute({ code, producer: "ds_query" });
          return result.ok ? ok(resultText(result.outputs)) : err(`${result.error?.ename}: ${result.error?.evalue}`);
        } catch (error) {
          return err(`Query failed: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_export",
      "Write a dataframe to disk as CSV, Parquet or JSON, relative to the session's working directory. Parquet requires pyarrow.",
      {
        name: NAME,
        path: z.string().min(1).describe("Destination path. The extension does not choose the format; `format` does."),
        format: z.enum(["csv", "parquet", "json", "jsonl"]),
      },
      async (args) => {
        const format = String(args.format);
        if (format === "parquet") {
          const gate = await needs(capability, "pyarrow");
          if (gate) return err(gate);
        }
        const name = String(args.name);
        const path = JSON.stringify(String(args.path));
        const writer = format === "csv" ? `${name}.to_csv(${path}, index=False)` : format === "parquet" ? `${name}.to_parquet(${path}, index=False)` : format === "jsonl" ? `${name}.to_json(${path}, orient="records", lines=True)` : `${name}.to_json(${path}, orient="records")`;
        try {
          const result = await capability.execute({ code: `import os as _os\n${writer}\n${py(`{"path": ${path}, "bytes": _os.path.getsize(${path}), "rows": int(len(${name}))}`)}`, producer: "ds_export" });
          return result.ok ? ok(resultText(result.outputs)) : err(`${result.error?.ename}: ${result.error?.evalue}`);
        } catch (error) {
          return err(`Export failed: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_snapshot",
      "Record the namespace as it is now — every variable's type, shape, dtypes, null counts, numeric stats and a content digest — under a name. Pair with ds_diff to see what a pipeline step silently changed.",
      { name: z.string().min(1).describe("A label like 'after-clean'."), vars: z.array(NAME).optional().describe("Only these variables. Default all.") },
      async (args) => {
        try {
          const snapshot = await capability.snapshot(String(args.name), Array.isArray(args.vars) ? args.vars.map(String) : undefined);
          return ok(`Snapshot ${snapshot.name}: ${Object.keys(snapshot.vars).length} variables.\n${Object.entries(snapshot.vars).map(([k, v]) => `${k}: ${v.type}${v.shape ? ` ${v.shape.join("×")}` : v.len !== undefined ? ` len ${v.len}` : ""}`).join("\n")}`);
        } catch (error) {
          return err(`Could not snapshot: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_diff",
      "Compare two snapshots: variables added, removed, and changed — with what changed (shape, columns, dtypes, nulls, stats, content). The thing to run after a step you did not expect to alter df.",
      { from: z.string().min(1), to: z.string().min(1).describe("A snapshot name, or 'now' to snapshot the live namespace first.") },
      async (args) => {
        try {
          const to = String(args.to);
          if (to === "now") await capability.snapshot("now");
          const diff = await capability.diff(String(args.from), to);
          const lines = [
            ...diff.added.map((n) => `+ ${n}`),
            ...diff.removed.map((n) => `- ${n}`),
            ...diff.changed.map((c) => `~ ${c.name}: ${c.what.join(", ")}`),
          ];
          return ok(lines.length ? lines.join("\n") : "No differences.");
        } catch (error) {
          return err(`Could not diff: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_checkpoint",
      "Pickle the whole namespace to disk under a name, list checkpoints, or restore one — so a kernel restart does not cost an hour of loads. Objects that will not pickle are skipped and named.",
      { action: z.enum(["save", "restore", "list"]), name: z.string().min(1).optional().describe("Required for save and restore.") },
      async (args) => {
        try {
          return json(await capability.checkpoint({ action: args.action as "save" | "restore" | "list", ...(typeof args.name === "string" ? { name: args.name } : {}) }));
        } catch (error) {
          return err(`Checkpoint failed: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_lineage",
      "Which executions assigned and read which variables, in order — the answer to 'what do I rerun if I change this'. Pass a variable to see only the executions that touched it.",
      { of: NAME.optional() },
      async (args) => {
        try {
          const rows = await capability.lineage(typeof args.of === "string" ? args.of : undefined);
          if (rows.length === 0) return ok("No lineage recorded yet.");
          return ok(rows.map((r) => `${new Date(r.at).toISOString().slice(11, 19)} ${r.producer.padEnd(14)} assigns [${r.assigned.join(", ")}] reads [${r.read.slice(0, 8).join(", ")}${r.read.length > 8 ? ", …" : ""}]  ${r.code.split("\n")[0]?.slice(0, 60)}`).join("\n"));
        } catch (error) {
          return err(`Could not read lineage: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_watch",
      "Register an assertion re-evaluated after every execution — `df.shape[0] > 1000`, `df['id'].is_unique`, `not df.isna().any().any()`. A violation is journaled the moment it happens, so a silent data change surfaces on the row that caused it. Call with no `assert` to list; `remove` to drop one.",
      { name: z.string().min(1), assert: z.string().optional().describe("A Python expression that must be truthy."), remove: z.boolean().optional() },
      async (args) => {
        try {
          const watches = await capability.watch({ name: String(args.name), ...(typeof args.assert === "string" ? { assert: args.assert } : {}), ...(args.remove === true ? { remove: true } : {}) });
          return ok(watches.length ? watches.map((w) => `${w.name}: ${w.assert}${w.lastResult ? ` → ${w.lastResult.ok ? "ok" : `VIOLATED ${w.lastResult.detail ?? ""}`}` : ""}`).join("\n") : "No watches.");
        } catch (error) {
          return err(`Could not update watches: ${failure(error)}`);
        }
      },
    ),

    tool(
      "ds_experiment",
      "A plain run log: start a named experiment with params, log metrics as many times as you like, end it. `list` shows every run with its last metrics so approaches can be compared without a tracking server.",
      {
        action: z.enum(["start", "log", "end", "list"]),
        name: z.string().min(1).optional().describe("Required for start; log and end address the most recent open run when omitted."),
        params: z.record(z.string(), z.unknown()).optional(),
        metrics: z.record(z.string(), z.number()).optional(),
      },
      async (args) => {
        try {
          const runs = await capability.experiment({ action: args.action as "start" | "log" | "end" | "list", ...(typeof args.name === "string" ? { name: args.name } : {}), ...(args.params && typeof args.params === "object" ? { params: args.params as Record<string, unknown> } : {}), ...(args.metrics && typeof args.metrics === "object" ? { metrics: args.metrics as Record<string, number> } : {}) });
          if (runs.length === 0) return ok("No experiments.");
          return ok(runs.map((r) => `${r.name}${r.endedAt ? "" : " (open)"}  params ${JSON.stringify(r.params)}  last ${JSON.stringify(r.metrics.at(-1) ?? {})}  (${r.metrics.length} logs)`).join("\n"));
        } catch (error) {
          return err(`Experiment failed: ${failure(error)}`);
        }
      },
    ),
  ];
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
