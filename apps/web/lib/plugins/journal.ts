/**
 * A PLUGIN'S JOURNAL ROWS — how an event a plugin emits draws in the transcript,
 * keyed by event type. The journal fold asks this table for any type it does
 * not know itself, so it never names Data Science or LaTeX.
 *
 * NOT GATED ON THE PLUGIN BEING ON. These render HISTORY: a compile that ran
 * last week still happened after the project turned LaTeX off.
 *
 * Each renderer answers the row for an event that belongs to a turn; the fold
 * only calls it when there is one (a cell run or a compile pressed on the panel
 * stays off the transcript).
 */
import type { EngineEvent } from "@telar/engine-client";
import type { JournalItem } from "@/lib/engine/journal";

type Renderer<T extends EngineEvent["type"]> = (event: Extract<EngineEvent, { type: T }>) => JournalItem | undefined;

const row = (event: EngineEvent, id: string) => ({
  id,
  runId: event.runId!,
  sessionId: event.sessionId,
  startedAt: event.at,
  completedAt: event.at,
  streamedText: "",
  openedBy: event.id,
});

const RENDERERS: { [T in "notebook.cell.output" | "latex.compile.finished" | "ds.watch.violated"]: Renderer<T> } = {
  /**
   * Data Science. ONLY THE FIGURES BECOME ROWS. Text and tables are already in
   * the tool result the model read; a plot is the one output a human wants to
   * SEE where it was made, and the gallery holds the rest.
   */
  "notebook.cell.output": (event) => {
    const output = event.output as { kind?: string; attachmentId?: string } | null;
    if (output?.kind !== "image" || !output.attachmentId) return undefined;
    return {
      ...row(event, `plot_${output.attachmentId}`),
      status: "completed",
      detail: { type: "unknown", label: `Drew a figure${event.producer ? ` — ${event.producer}` : ""}` },
      plotAttachmentId: output.attachmentId,
    };
  },
  /**
   * LaTeX. ONE ROW PER COMPILE — the counts and the first error, never the
   * log; the LaTeX surface holds the full diagnostics.
   */
  "latex.compile.finished": (event) => ({
    ...row(event, `latex_${event.id}`),
    status: event.ok ? "completed" : "failed",
    detail: event.ok
      ? { type: "unknown", label: `Compiled ${event.path}${event.warnings ? ` — ${event.warnings} warning${event.warnings === 1 ? "" : "s"}` : ""}` }
      : { type: "error", error: { message: `Compile of ${event.path} failed — ${event.errors} error${event.errors === 1 ? "" : "s"}${event.firstError ? `, first: ${event.firstError}` : ""}` } },
  }),
  /** Data Science. A watched variable broke its assertion. */
  "ds.watch.violated": (event) => ({
    ...row(event, `watch_${event.id}`),
    status: "failed",
    detail: { type: "error", error: { message: `Watch "${event.watch}" violated: ${event.assert}${event.detail ? ` (${event.detail})` : ""}` } },
  }),
};

/** The transcript row a plugin draws for this event, or nothing. */
export function pluginJournalRow(event: EngineEvent): JournalItem | undefined {
  const render = (RENDERERS as Record<string, Renderer<EngineEvent["type"]> | undefined>)[event.type];
  return render?.(event as never);
}
