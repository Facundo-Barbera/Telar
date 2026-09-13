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

/**
 * WHAT THE KERNEL IS DOING RIGHT NOW, folded out of the journal.
 *
 * The Data tab used to ASK — one `GET /kernel` on mount, and again only when
 * the turn's state changed — so a pill sat on IDLE through a 35-second
 * `ds_scratch` and told the reader nothing was running while something was
 * (#356). It was not a slow poll; it was no poll at all.
 *
 * A read is the wrong shape for this regardless. The kernel already announces
 * every transition (the bridge's `_set_state`, journalled as
 * `kernel.state.changed`), those events already stream to this client, and
 * folding them is how the panel learns the same fact about the browser next
 * door. Busy then means busy for EVERY execution — a cell the human ran, a
 * `ds_*` call the agent made — because the announcement is the kernel's, not
 * the caller's.
 *
 * Undefined means the journal has not mentioned the kernel, which is not the
 * same as no kernel: a session opened long after its kernel started has the
 * event out of its window, and the caller's own read is the better answer.
 */
export function latestKernelState(events: readonly { type: string; state?: string }[]): KernelState | undefined {
  let state: KernelState | undefined;
  for (const event of events) {
    if (event.type === "kernel.state.changed" && event.state) state = event.state as KernelState;
  }
  return state;
}

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
