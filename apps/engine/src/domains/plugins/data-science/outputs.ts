import { z } from "zod";

const TextOutput = z.object({
  kind: z.literal("text"),
  stream: z.enum(["stdout", "stderr", "result"]),
  text: z.string(),
  truncated: z.boolean().optional(),
});
const HtmlOutput = z.object({ kind: z.literal("html"), html: z.string(), truncated: z.boolean().optional() });
const ImageOutput = z.object({
  kind: z.literal("image"),
  mediaType: z.enum(["image/png", "image/svg+xml"]),
  dataB64: z.string().optional(),
  attachmentId: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
const JsonOutput = z.object({ kind: z.literal("json"), value: z.unknown() });
const DataframeOutput = z.object({
  kind: z.literal("dataframe"),
  columns: z.array(z.string()),
  dtypes: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
  shape: z.tuple([z.number(), z.number()]),
  truncated: z.boolean(),
});
const ErrorOutput = z.object({
  kind: z.literal("error"),
  ename: z.string(),
  evalue: z.string(),
  traceback: z.array(z.string()),
});
const ClearOutput = z.object({ kind: z.literal("clear") });

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

export function plainTraceback(lines: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

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

const PLOT_TITLE_MARKER = "__TELAR_PLOT_TITLE__";

export const PLOT_TITLE_PROBE = [
  "try:",
  "    import matplotlib.pyplot as _tplt",
  "    _tfig = _tplt.gcf()",
  "    _tsup = getattr(_tfig, '_suptitle', None)",
  "    _ttitle = (_tsup.get_text() if _tsup is not None else '') or (_tfig.axes[-1].get_title() if _tfig.axes else '')",
  `    print("${PLOT_TITLE_MARKER}" + (_ttitle or '').strip())`,
  "except Exception:",
  "    pass",
  "",
].join("\n");

export function plotTitleFrom(outputs: readonly CellOutput[]): string | undefined {
  for (const output of outputs) {
    if (output.kind !== "text") continue;
    for (const line of output.text.split("\n")) {
      if (!line.startsWith(PLOT_TITLE_MARKER)) continue;
      const title = line.slice(PLOT_TITLE_MARKER.length).trim();
      if (title) return title;
    }
  }
  return undefined;
}

export function withoutPlotTitle(outputs: readonly CellOutput[]): CellOutput[] {
  const kept: CellOutput[] = [];
  for (const output of outputs) {
    if (output.kind !== "text" || !output.text.includes(PLOT_TITLE_MARKER)) {
      kept.push(output);
      continue;
    }
    const text = output.text
      .split("\n")
      .filter((line) => !line.startsWith(PLOT_TITLE_MARKER))
      .join("\n");
    if (text.trim()) kept.push({ ...output, text });
  }
  return kept;
}
