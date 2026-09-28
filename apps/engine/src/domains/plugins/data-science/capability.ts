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
  executable?: string;
};

export type EnvironmentRow = {
  id: string;
  name: string;
  manager: string;
  root: string;
  python: string;
  version?: string;
  inUse: boolean;
};

export type VarRow = { name: string; type: string; shape?: number[]; len?: number; sizeBytes?: number; repr?: string };

export type DsCapability = {
  kernel(): Promise<KernelStatus>;
  execute(input: { code: string; cellId?: string; timeoutMs?: number; producer?: string }): Promise<ExecResult>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  vars(limit?: number): Promise<VarRow[]>;
  inspect(name: string, depth?: number): Promise<Record<string, unknown>>;

  notebookRead(path: string, options?: { from?: number; to?: number; withOutputs?: boolean }): Promise<NotebookRead>;
  notebookEdit(path: string, edit: NotebookEdit): Promise<NotebookRead>;
  notebookRun(path: string, input: { cellId?: string; all?: boolean; stopOnError?: boolean }): Promise<{ results: Array<{ cellId: string; result: ExecResult }>; notebook: NotebookRead }>;

  plot(input: { code: string; title?: string }): Promise<{ attachmentId?: string; outputs: CellOutput[]; ok: boolean; error?: string }>;

  snapshot(name: string, vars?: string[]): Promise<Snapshot>;
  snapshots(): Promise<{ name: string; at: number }[]>;
  diff(from: string, to: string): Promise<SnapshotDiff>;
  checkpoint(input: { action: "save" | "restore" | "list"; name?: string }): Promise<unknown>;
  lineage(of?: string): Promise<LineageRow[]>;
  watches(): Promise<Watch[]>;
  watch(input: { name: string; assert?: string; remove?: boolean }): Promise<Watch[]>;
  experiment(input: { action: "start" | "log" | "end" | "list"; name?: string; params?: Record<string, unknown>; metrics?: Record<string, number> }): Promise<Experiment[]>;

  environment(input?: { use?: string }): Promise<{ environments: EnvironmentRow[]; switched?: string }>;

  packages(): Promise<{ packages: PackageRow[]; environment: { manager: string; root: string; python: string } }>;
  install(input: { add?: string[]; remove?: string[]; requirements?: string }): Promise<{ ok: boolean; lines: string[]; error?: string }>;
};

export type PackageRow = { name: string; version: string; channel?: string; direct?: boolean };

export type NotebookEdit =
  | { kind: "set"; cellId?: string; index?: number; source?: string; cellType?: "code" | "markdown" | "raw" }
  | { kind: "insert"; after?: string | number; source: string; cellType?: "code" | "markdown" | "raw" }
  | { kind: "delete"; cellId?: string; index?: number }
  | { kind: "move"; cellId?: string; index?: number; to: number }
  | { kind: "clearOutputs"; cellId?: string; index?: number }
  | { kind: "create" };

export type SnapshotDiff = {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  changed: Array<{ name: string; before: Record<string, unknown>; after: Record<string, unknown>; what: string[] }>;
};
