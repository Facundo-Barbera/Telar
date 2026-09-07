/**
 * What the `notebook_*` and `ds_*` toolkits may do — a thin port, one member
 * per store method, exactly as `SpoolCapability` and `SessionsCapability` are.
 * Validation lives behind it; the walls compose sentences.
 *
 * TWO IMPLEMENTATIONS, ONE SHAPE: the worker builds this out of `EngineClient`
 * HTTP calls (it holds no store handle), the daemon's tests build it out of
 * `store.*`. Both land on the same kernel, because the kernel is the daemon's.
 */
import type { CellOutput, ExecResult, KernelState } from "./outputs";
import type { Experiment, LineageRow, Snapshot, Watch } from "./state-files";

export type NotebookCellSummary = {
  id: string;
  index: number;
  type: "code" | "markdown" | "raw";
  source: string;
  executionCount?: number | null;
  outputs?: CellOutput[];
};

export type NotebookRead = {
  path: string;
  sha256: string;
  cellCount: number;
  cells: NotebookCellSummary[];
  metadata?: Record<string, unknown>;
};

export type KernelStatus = {
  state: KernelState | "none";
  executionCount?: number;
  modules?: Record<string, boolean>;
  python?: string;
};

export type VarRow = { name: string; type: string; shape?: number[]; len?: number; sizeBytes?: number; repr?: string };

export type DsCapability = {
  /** Which analysis libraries import in this session's kernel, once started. */
  kernel(): Promise<KernelStatus>;
  execute(input: { code: string; cellId?: string; timeoutMs?: number; producer?: string }): Promise<ExecResult>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  vars(limit?: number): Promise<VarRow[]>;
  inspect(name: string, depth?: number): Promise<Record<string, unknown>>;

  notebookRead(path: string, options?: { from?: number; to?: number; withOutputs?: boolean }): Promise<NotebookRead>;
  notebookEdit(path: string, edit: NotebookEdit): Promise<NotebookRead>;
  /** Execute one cell (or all), writing outputs back into the file. */
  notebookRun(path: string, input: { cellId?: string; all?: boolean; stopOnError?: boolean }): Promise<{ results: Array<{ cellId: string; result: ExecResult }>; notebook: NotebookRead }>;

  /** A rendered figure, stored. Returns the attachment id and what the model can say about it. */
  plot(input: { code: string; title?: string }): Promise<{ attachmentId?: string; outputs: CellOutput[]; ok: boolean; error?: string }>;

  snapshot(name: string, vars?: string[]): Promise<Snapshot>;
  snapshots(): Promise<{ name: string; at: number }[]>;
  diff(from: string, to: string): Promise<SnapshotDiff>;
  checkpoint(input: { action: "save" | "restore" | "list"; name?: string }): Promise<unknown>;
  lineage(of?: string): Promise<LineageRow[]>;
  watches(): Promise<Watch[]>;
  watch(input: { name: string; assert?: string; remove?: boolean }): Promise<Watch[]>;
  experiment(input: { action: "start" | "log" | "end" | "list"; name?: string; params?: Record<string, unknown>; metrics?: Record<string, number> }): Promise<Experiment[]>;
};

export type NotebookEdit =
  | { kind: "set"; cellId?: string; index?: number; source?: string; cellType?: "code" | "markdown" | "raw" }
  | { kind: "insert"; after?: string | number; source: string; cellType?: "code" | "markdown" | "raw" }
  | { kind: "delete"; cellId?: string; index?: number }
  | { kind: "create" };

export type SnapshotDiff = {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  changed: Array<{ name: string; before: Record<string, unknown>; after: Record<string, unknown>; what: string[] }>;
};
