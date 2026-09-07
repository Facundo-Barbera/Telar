/**
 * The cockpit's view of a cell's output. Mirrors the engine's `CellOutput`
 * union (apps/engine/src/ds/outputs.ts) — kept as a plain type here because the
 * engine's zod schema is not part of the client contract, and the union is
 * small enough that a drift would be caught the first time a cell rendered.
 */
export type CellOutput =
  | { kind: "text"; stream: "stdout" | "stderr" | "result"; text: string; truncated?: boolean }
  | { kind: "html"; html: string; truncated?: boolean }
  | { kind: "image"; mediaType: "image/png" | "image/svg+xml"; dataB64?: string; attachmentId?: string; width?: number; height?: number }
  | { kind: "json"; value: unknown }
  | { kind: "dataframe"; columns: string[]; dtypes: string[]; rows: unknown[][]; shape: [number, number]; truncated: boolean }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] }
  | { kind: "clear" };

export type KernelState = "starting" | "idle" | "busy" | "restarting" | "dead" | "none";

export type NotebookCell = {
  id: string;
  index: number;
  type: "code" | "markdown" | "raw";
  source: string;
  executionCount?: number | null;
  outputs?: CellOutput[];
};

export type NotebookRead = { path: string; sha256: string; cellCount: number; cells: NotebookCell[] };

export type ExecResult = {
  execId: string;
  ok: boolean;
  executionCount: number | null;
  error?: { ename: string; evalue: string; traceback: string[] };
  outputs: CellOutput[];
};

export type VarRow = { name: string; type: string; shape?: number[]; len?: number; sizeBytes?: number; repr?: string };

export type TableWindow = { path: string; columns: string[]; dtypes?: string[]; total: number; offset: number; rows: unknown[][]; truncated?: boolean };

/** The URL the cockpit serves an attachment's bytes from. */
export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** ANSI colour codes IPython puts in tracebacks. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
