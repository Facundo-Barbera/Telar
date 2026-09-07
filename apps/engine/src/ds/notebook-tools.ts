/**
 * `notebook_*` — a session's `.ipynb` files, read, edited and run in the
 * session's own kernel.
 *
 * THE FILE IS THE TRUTH. Every tool reads the notebook fresh and writes it
 * back with the outputs the kernel produced, so a human opening the same file
 * in the panel sees what the model did, and a model reading it sees what the
 * human ran. The hash-fenced write lives in the capability; a stale write is
 * refused there, and the wall says so in words.
 */
import { z } from "zod";
import { err, failure, json, ok, type ToolFactory } from "../tool-kit";
import type { DsCapability, NotebookCellSummary } from "./capability";
import { describeOutputs } from "./outputs";

const cellLine = (cell: NotebookCellSummary): string => {
  const head = cell.source.split("\n")[0]?.slice(0, 80) ?? "";
  const count = cell.type === "code" ? `[${cell.executionCount ?? " "}]` : "    ";
  const last = cell.outputs?.at(-1);
  const tail = last ? ` → ${last.kind}${last.kind === "error" ? ` ${last.ename}` : ""}` : "";
  return `${String(cell.index).padStart(3)} ${cell.id} ${count} ${cell.type.padEnd(8)} ${head}${cell.source.includes("\n") ? " …" : ""}${tail}`;
};

const PATH = z.string().min(1).describe("Path to the .ipynb, relative to the session's working directory.");

export function notebookTools(tool: ToolFactory, capability: DsCapability): unknown[] {
  return [
    tool(
      "notebook_open",
      "Read a notebook's shape: every cell's id, index, type, first line, execution count and last output kind. Start here — the ids are what every other notebook_* tool takes. A path that does not exist is created as an empty notebook when `create` is true.",
      {
        path: PATH,
        create: z.boolean().optional().describe("Create an empty notebook at this path if none exists."),
      },
      async (args) => {
        const path = String(args.path);
        try {
          const nb = args.create === true ? await capability.notebookEdit(path, { kind: "create" }) : await capability.notebookRead(path);
          return ok(`${nb.path} — ${nb.cellCount} cells (sha ${nb.sha256.slice(0, 12)})\n${nb.cells.map(cellLine).join("\n")}`);
        } catch (error) {
          return err(`Could not open ${path}: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_cells",
      "The full source (and outputs, if asked) of a range of cells. Bounded by `from`/`to` indices so a long notebook does not land in your context whole.",
      {
        path: PATH,
        from: z.number().int().min(0).optional().describe("First cell index, inclusive. Default 0."),
        to: z.number().int().min(0).optional().describe("Last cell index, inclusive. Default from+9."),
        withOutputs: z.boolean().optional().describe("Include each code cell's outputs, rendered as text."),
      },
      async (args) => {
        try {
          const from = typeof args.from === "number" ? args.from : 0;
          const to = typeof args.to === "number" ? args.to : from + 9;
          const nb = await capability.notebookRead(String(args.path), { from, to, withOutputs: args.withOutputs === true });
          const blocks = nb.cells.map((cell) => {
            const header = `# ── cell ${cell.index} (${cell.id}, ${cell.type}${cell.type === "code" ? `, [${cell.executionCount ?? " "}]` : ""}) ──`;
            const outputs = cell.outputs?.length ? `\n# outputs:\n${describeOutputs(cell.outputs, 3000).split("\n").map((l) => `#   ${l}`).join("\n")}` : "";
            return `${header}\n${cell.source}${outputs}`;
          });
          return ok(blocks.join("\n\n") || "(no cells in that range)");
        } catch (error) {
          return err(`Could not read cells: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_edit_cell",
      "One structural edit: set a cell's source or type, insert a new cell after another, or delete one. Address cells by id (stable) or index (shifts after inserts and deletes). Editing does not run anything — call notebook_run_cell for that.",
      {
        path: PATH,
        cellId: z.string().optional().describe("The cell to change or delete, by id from notebook_open."),
        index: z.number().int().min(0).optional().describe("The cell to change or delete, by index. Prefer cellId."),
        source: z.string().optional().describe("New source for the cell (set), or the source of the new cell (insert)."),
        cellType: z.enum(["code", "markdown", "raw"]).optional().describe("Change the cell's type, or the type of an inserted cell. Default code."),
        insertAfter: z.union([z.string(), z.number().int()]).optional().describe("Insert a NEW cell after this id or index (-1 for the top). Requires `source`."),
        delete: z.boolean().optional().describe("Delete the addressed cell."),
      },
      async (args) => {
        const path = String(args.path);
        try {
          const cellType = args.cellType as "code" | "markdown" | "raw" | undefined;
          let nb;
          if (args.delete === true) {
            nb = await capability.notebookEdit(path, { kind: "delete", ...(typeof args.cellId === "string" ? { cellId: args.cellId } : {}), ...(typeof args.index === "number" ? { index: args.index } : {}) });
          } else if (args.insertAfter !== undefined) {
            if (typeof args.source !== "string") return err("insertAfter needs `source` for the new cell.");
            nb = await capability.notebookEdit(path, { kind: "insert", after: args.insertAfter as string | number, source: args.source, ...(cellType ? { cellType } : {}) });
          } else {
            if (typeof args.source !== "string" && !cellType) return err("Nothing to change: give `source`, `cellType`, `insertAfter` or `delete`.");
            nb = await capability.notebookEdit(path, { kind: "set", ...(typeof args.cellId === "string" ? { cellId: args.cellId } : {}), ...(typeof args.index === "number" ? { index: args.index } : {}), ...(typeof args.source === "string" ? { source: args.source } : {}), ...(cellType ? { cellType } : {}) });
          }
          return ok(`${nb.path} — ${nb.cellCount} cells\n${nb.cells.map(cellLine).join("\n")}`);
        } catch (error) {
          return err(`Could not edit ${path}: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_run_cell",
      "Execute ONE code cell in the session's kernel and write its outputs back into the file. State persists between runs — variables a cell assigned are there for the next. Images land in the session's plots; you get their attachment ids.",
      { path: PATH, cellId: z.string().min(1).describe("The cell to run, by id.") },
      async (args) => {
        try {
          const { results } = await capability.notebookRun(String(args.path), { cellId: String(args.cellId) });
          const first = results[0];
          if (!first) return err("That cell produced no result.");
          const { result } = first;
          const text = describeOutputs(result.outputs);
          return result.ok ? ok(`[${result.executionCount ?? " "}] ok\n${text}`) : err(`[${result.executionCount ?? " "}] ${result.error?.ename ?? "error"}: ${result.error?.evalue ?? ""}\n${text}`);
        } catch (error) {
          return err(`Could not run cell: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_run_all",
      "Execute every code cell top to bottom, writing outputs back. Stops at the first error unless `stopOnError` is false. Returns one line per cell; use notebook_cells with withOutputs for the detail.",
      { path: PATH, stopOnError: z.boolean().optional().describe("Default true.") },
      async (args) => {
        try {
          const { results } = await capability.notebookRun(String(args.path), { all: true, stopOnError: args.stopOnError !== false });
          const lines = results.map(({ cellId, result }) => `${cellId} [${result.executionCount ?? " "}] ${result.ok ? "ok" : `${result.error?.ename}: ${result.error?.evalue}`} (${result.outputs.length} outputs)`);
          const failed = results.filter((r) => !r.result.ok).length;
          return failed ? err(`${failed} cell(s) failed\n${lines.join("\n")}`) : ok(lines.join("\n") || "(no code cells)");
        } catch (error) {
          return err(`Could not run notebook: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_interrupt",
      "Send an interrupt to the running cell. The kernel and its variables survive; only the current execution stops.",
      {},
      async () => {
        try {
          await capability.interrupt();
          return ok("Interrupt sent.");
        } catch (error) {
          return err(`Could not interrupt: ${failure(error)}`);
        }
      },
    ),

    tool(
      "notebook_restart",
      "Restart the session's kernel. EVERY VARIABLE IS LOST — call ds_checkpoint first if an hour of loads is in there. The notebook files are untouched.",
      {},
      async () => {
        try {
          await capability.restart();
          return json({ restarted: true, note: "The namespace is empty. Re-run cells or ds_checkpoint restore." });
        } catch (error) {
          return err(`Could not restart: ${failure(error)}`);
        }
      },
    ),
  ];
}
