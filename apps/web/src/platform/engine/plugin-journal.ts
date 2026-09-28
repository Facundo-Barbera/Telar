import type { EngineEvent } from "@telar/engine-client";
import type { JournalItem } from "@/platform/engine";

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
  "latex.compile.finished": (event) => ({
    ...row(event, `latex_${event.id}`),
    status: event.ok ? "completed" : "failed",
    detail: event.ok
      ? { type: "unknown", label: `Compiled ${event.path}${event.warnings ? ` — ${event.warnings} warning${event.warnings === 1 ? "" : "s"}` : ""}` }
      : { type: "error", error: { message: `Compile of ${event.path} failed — ${event.errors} error${event.errors === 1 ? "" : "s"}${event.firstError ? `, first: ${event.firstError}` : ""}` } },
  }),
  "ds.watch.violated": (event) => ({
    ...row(event, `watch_${event.id}`),
    status: "failed",
    detail: { type: "error", error: { message: `Watch "${event.watch}" violated: ${event.assert}${event.detail ? ` (${event.detail})` : ""}` } },
  }),
};

export function pluginJournalRow(event: EngineEvent): JournalItem | undefined {
  const render = (RENDERERS as Record<string, Renderer<EngineEvent["type"]> | undefined>)[event.type];
  return render?.(event as never);
}
