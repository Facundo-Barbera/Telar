/**
 * What a cell produces, as the engine and the cockpit both read it.
 *
 * ONE CLOSED UNION, shaped in the bridge before the bytes cross stdio. Jupyter's
 * mime bundles are open-ended and a client that had to handle them would grow
 * a `switch` per renderer; here there are six kinds and every consumer — the
 * journal, the notebook file, the tool result — meets the same six.
 *
 * `image` CARRIES BYTES ONLY IN FLIGHT. The host persists them to the session's
 * attachment store and replaces `dataB64` with `attachmentId` before anything
 * is journaled or written to a notebook, so a plot is a file on disk that the
 * gallery, the transcript and the model all address the same way.
 */
import { z } from "zod";

export const TextOutput = z.object({
  kind: z.literal("text"),
  stream: z.enum(["stdout", "stderr", "result"]),
  text: z.string(),
  truncated: z.boolean().optional(),
});
export const HtmlOutput = z.object({ kind: z.literal("html"), html: z.string(), truncated: z.boolean().optional() });
export const ImageOutput = z.object({
  kind: z.literal("image"),
  mediaType: z.enum(["image/png", "image/svg+xml"]),
  dataB64: z.string().optional(),
  attachmentId: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export const JsonOutput = z.object({ kind: z.literal("json"), value: z.unknown() });
export const DataframeOutput = z.object({
  kind: z.literal("dataframe"),
  columns: z.array(z.string()),
  dtypes: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  shape: z.tuple([z.number(), z.number()]),
  truncated: z.boolean(),
});
export const ErrorOutput = z.object({
  kind: z.literal("error"),
  ename: z.string(),
  evalue: z.string(),
  traceback: z.array(z.string()),
});
export const ClearOutput = z.object({ kind: z.literal("clear") });

export const CellOutput = z.discriminatedUnion("kind", [TextOutput, HtmlOutput, ImageOutput, JsonOutput, DataframeOutput, ErrorOutput, ClearOutput]);
export type CellOutput = z.infer<typeof CellOutput>;

export const KernelState = z.enum(["starting", "idle", "busy", "restarting", "dead"]);
export type KernelState = z.infer<typeof KernelState>;

export type ExecResult = {
  execId: string;
  ok: boolean;
  executionCount: number | null;
  error?: { ename: string; evalue: string; traceback: string[] };
  outputs: CellOutput[];
};

/** Strip ANSI escapes IPython puts in tracebacks — a model reads them as noise. */
export function plainTraceback(lines: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((line) => line.replace(/\[[0-9;]*m/g, ""));
}

/**
 * The outputs as a model should read them: text inline, tables as a compact
 * grid, images by attachment id, errors as a plain traceback. Bounded, because
 * this lands in a context window.
 */
export function describeOutputs(outputs: CellOutput[], limit = 12_000): string {
  const parts: string[] = [];
  for (const output of outputs) {
    switch (output.kind) {
      case "text":
        parts.push(output.stream === "stderr" ? `[stderr] ${output.text}` : output.text);
        break;
      case "html":
        parts.push(`[html output, ${output.html.length} chars${output.truncated ? ", truncated" : ""}]`);
        break;
      case "image":
        parts.push(`[image ${output.mediaType}${output.attachmentId ? ` attachment:${output.attachmentId}` : ""}]`);
        break;
      case "json":
        parts.push(JSON.stringify(output.value, null, 1).slice(0, 4000));
        break;
      case "dataframe": {
        const header = output.columns.join(" | ");
        const rows = output.rows.slice(0, 20).map((row) => row.map((cell) => String(cell ?? "")).join(" | "));
        parts.push(`[dataframe ${output.shape[0]}×${output.shape[1]}${output.truncated ? ", preview" : ""}]\n${header}\n${rows.join("\n")}`);
        break;
      }
      case "error":
        parts.push(`${output.ename}: ${output.evalue}\n${plainTraceback(output.traceback).join("\n")}`);
        break;
      case "clear":
        break;
    }
  }
  const text = parts.join("\n");
  return text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} chars elided]` : text;
}
