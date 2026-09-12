/**
 * nbformat 4 in and out, without losing anything we do not understand.
 *
 * A NOTEBOOK IS SOMEBODY'S FILE. VS Code, JupyterLab and every extension leave
 * keys on the notebook, on `metadata`, and on each cell; a round-trip that
 * dropped them would show up as a git diff nobody asked for. So the parse
 * keeps every unknown key, cells are minted ids only when they lack one
 * (nbformat < 4.5), and the write uses nbformat's own 1-space indent and
 * trailing newline so an untouched notebook diffs to nothing.
 *
 * OUTPUTS ARE TRANSLATED BOTH WAYS. The engine's `CellOutput` union becomes
 * `stream` / `execute_result` / `display_data` / `error` on write; images
 * carry an `attachmentId` in `metadata.telar` and the PNG bytes in
 * `data["image/png"]` so the file still opens anywhere.
 */
import crypto from "node:crypto";
import type { CellOutput } from "./outputs";

export type NbCell = {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string;
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
  [extra: string]: unknown;
};

export type Notebook = {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbCell[];
  [extra: string]: unknown;
};

const joinSource = (source: unknown): string => (Array.isArray(source) ? source.join("") : typeof source === "string" ? source : "");

export function mintCellId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function emptyNotebook(): Notebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
    cells: [{ id: mintCellId(), cell_type: "code", source: "", metadata: {}, execution_count: null, outputs: [] }],
  };
}

export function parseNotebook(text: string): Notebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a notebook object");
  const nb = raw as Record<string, unknown>;
  if (nb.nbformat !== 4) throw new Error(`nbformat ${String(nb.nbformat)} is not supported; only 4`);
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  const seen = new Set<string>();
  const parsed: NbCell[] = cells.map((cell) => {
    const c = (cell && typeof cell === "object" ? cell : {}) as Record<string, unknown>;
    const type = c.cell_type === "markdown" || c.cell_type === "raw" ? c.cell_type : "code";
    let id = typeof c.id === "string" && c.id ? c.id : mintCellId();
    while (seen.has(id)) id = mintCellId();
    seen.add(id);
    return {
      ...c,
      id,
      cell_type: type,
      source: joinSource(c.source),
      metadata: c.metadata && typeof c.metadata === "object" ? (c.metadata as Record<string, unknown>) : {},
      ...(type === "code" ? { execution_count: typeof c.execution_count === "number" ? c.execution_count : null, outputs: Array.isArray(c.outputs) ? c.outputs : [] } : {}),
    } as NbCell;
  });
  return {
    ...nb,
    nbformat: 4,
    nbformat_minor: typeof nb.nbformat_minor === "number" ? Math.max(nb.nbformat_minor, 5) : 5,
    metadata: nb.metadata && typeof nb.metadata === "object" ? (nb.metadata as Record<string, unknown>) : {},
    cells: parsed,
  };
}

/** nbformat writes sources as line arrays and indents by one space. */
export function serializeNotebook(nb: Notebook): string {
  const cells = nb.cells.map((cell) => {
    const { source, ...rest } = cell;
    const ordered: Record<string, unknown> = { cell_type: rest.cell_type, id: rest.id, metadata: rest.metadata };
    if (rest.cell_type === "code") {
      ordered.execution_count = rest.execution_count ?? null;
      ordered.outputs = rest.outputs ?? [];
    }
    for (const [key, value] of Object.entries(rest)) if (!(key in ordered)) ordered[key] = value;
    ordered.source = splitLines(source);
    return ordered;
  });
  const { cells: _c, ...rest } = nb;
  const out: Record<string, unknown> = { cells, metadata: rest.metadata, nbformat: rest.nbformat, nbformat_minor: rest.nbformat_minor };
  for (const [key, value] of Object.entries(rest)) if (!(key in out)) out[key] = value;
  return `${JSON.stringify(out, null, 1)}\n`;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

/** Engine outputs → nbformat outputs. */
export function toNbOutputs(outputs: CellOutput[], images: (attachmentId: string) => string | undefined): unknown[] {
  const out: unknown[] = [];
  for (const o of outputs) {
    switch (o.kind) {
      case "text":
        if (o.stream === "result") out.push({ output_type: "execute_result", execution_count: null, data: { "text/plain": splitLines(o.text) }, metadata: {} });
        else out.push({ output_type: "stream", name: o.stream, text: splitLines(o.text) });
        break;
      case "html":
        out.push({ output_type: "display_data", data: { "text/html": splitLines(o.html) }, metadata: {} });
        break;
      case "image": {
        const b64 = o.attachmentId ? images(o.attachmentId) : o.dataB64;
        const data = b64 ? { [o.mediaType]: o.mediaType === "image/svg+xml" ? Buffer.from(b64, "base64").toString("utf8") : b64 } : {};
        out.push({ output_type: "display_data", data, metadata: { ...(o.attachmentId ? { telar: { attachmentId: o.attachmentId } } : {}) } });
        break;
      }
      case "json":
        out.push({ output_type: "display_data", data: { "application/json": o.value }, metadata: {} });
        break;
      case "dataframe":
        out.push({ output_type: "display_data", data: { "application/vnd.telar.dataframe+json": JSON.stringify({ columns: o.columns, dtypes: o.dtypes, rows: o.rows, shape: o.shape, truncated: o.truncated }), "text/plain": [`[dataframe ${o.shape[0]}×${o.shape[1]}]`] }, metadata: {} });
        break;
      case "error":
        out.push({ output_type: "error", ename: o.ename, evalue: o.evalue, traceback: o.traceback });
        break;
      case "clear":
        out.length = 0;
        break;
    }
  }
  return out;
}

/** nbformat outputs → engine outputs, for reading a notebook somebody else ran. */
export function fromNbOutputs(outputs: unknown[]): CellOutput[] {
  const result: CellOutput[] = [];
  for (const raw of outputs) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const data = (o.data && typeof o.data === "object" ? o.data : {}) as Record<string, unknown>;
    switch (o.output_type) {
      case "stream":
        result.push({ kind: "text", stream: o.name === "stderr" ? "stderr" : "stdout", text: joinSource(o.text) });
        break;
      case "error":
        result.push({ kind: "error", ename: String(o.ename ?? "Error"), evalue: String(o.evalue ?? ""), traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [] });
        break;
      case "execute_result":
      case "display_data": {
        const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
        const telar = (meta.telar && typeof meta.telar === "object" ? meta.telar : {}) as Record<string, unknown>;
        if (typeof data["application/vnd.telar.dataframe+json"] === "string") {
          try {
            const frame = JSON.parse(data["application/vnd.telar.dataframe+json"] as string) as Omit<Extract<CellOutput, { kind: "dataframe" }>, "kind">;
            result.push({ kind: "dataframe", ...frame });
            break;
          } catch { /* fall through */ }
        }
        if (data["image/png"]) result.push({ kind: "image", mediaType: "image/png", dataB64: joinSource(data["image/png"]).trim(), ...(typeof telar.attachmentId === "string" ? { attachmentId: telar.attachmentId } : {}) });
        else if (data["image/svg+xml"]) result.push({ kind: "image", mediaType: "image/svg+xml", dataB64: Buffer.from(joinSource(data["image/svg+xml"])).toString("base64") });
        else if (data["text/html"]) result.push({ kind: "html", html: joinSource(data["text/html"]) });
        else if (data["application/json"] !== undefined) result.push({ kind: "json", value: data["application/json"] });
        else result.push({ kind: "text", stream: "result", text: joinSource(data["text/plain"]) });
        break;
      }
    }
  }
  return result;
}

/**
 * Reorder, carrying THE CELL OBJECT rather than its text.
 *
 * A move expressed as delete-then-insert would mint a new id and drop
 * `outputs` and `execution_count` — the record of what actually ran, and the
 * reason a person scrolls back up a notebook at all. So the cell is spliced
 * out and back in whole: id, source, type, metadata, outputs and count are the
 * same object at a different index, and every unknown vendor key rides along
 * with it.
 *
 * `to` is the index the cell OCCUPIES AFTERWARDS, so `to === from` leaves the
 * array — and therefore the file — untouched. Out of range is refused rather
 * than clamped, in `findCell`'s voice: a caller asking to move the top cell up
 * has a bug in its own disabled-button state, and a silent no-op hides it the
 * way an out-of-range `index` on `set` is not allowed to.
 */
export function moveCell(nb: Notebook, from: number, to: number): void {
  if (!Number.isInteger(to) || to < 0 || to >= nb.cells.length) throw new Error(`move target ${to} is out of range (0..${nb.cells.length - 1})`);
  const [cell] = nb.cells.splice(from, 1);
  if (cell) nb.cells.splice(to, 0, cell);
}

/**
 * Drop one cell's outputs and the count beside them.
 *
 * THE COUNT GOES WITH THEM. `execution_count` is not a separate fact from the
 * outputs — it is the label on them ("[7]" beside what [7] printed) — so a
 * cell left holding a count with nothing under it claims to have run and to
 * have said nothing, which is a different and untrue thing. `null` is
 * nbformat's own "never ran", and it is what `emptyNotebook` and the type
 * change in `set` already write.
 *
 * A CELL THAT CANNOT HAVE OUTPUTS IS REFUSED, in `notebookRun`'s voice and for
 * its reason: markdown and raw cells carry no `outputs` key at all (`set`
 * deletes it on the way out of `code`), so clearing one is a caller asking for
 * something that does not exist, and answering "done" would hide the bug in
 * whatever offered the verb.
 */
export function clearCellOutputs(nb: Notebook, at: number): void {
  const cell = nb.cells[at]!;
  if (cell.cell_type !== "code") throw new Error(`cell ${cell.id} is ${cell.cell_type}, not code`);
  cell.outputs = [];
  cell.execution_count = null;
}

export function findCell(nb: Notebook, ref: { cellId?: string; index?: number }): number {
  if (ref.cellId !== undefined) {
    const at = nb.cells.findIndex((cell) => cell.id === ref.cellId);
    if (at < 0) throw new Error(`no cell with id ${ref.cellId}`);
    return at;
  }
  if (ref.index !== undefined) {
    if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= nb.cells.length) throw new Error(`cell index ${ref.index} is out of range (0..${nb.cells.length - 1})`);
    return ref.index;
  }
  throw new Error("name a cell by id or index");
}
