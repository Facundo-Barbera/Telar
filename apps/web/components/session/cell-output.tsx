"use client";

/**
 * One renderer per output kind. Images come from the attachment route (the
 * engine persisted them before anything was journaled), so this never holds
 * base64 — a notebook with forty plots is forty small `<img>` tags.
 */
import { useState } from "react";
import { attachmentUrl, stripAnsi, type CellOutput } from "@/lib/ds";
import { cn } from "@/lib/utils";

export function CellOutputView({ output, sessionId, onOpenImage }: { output: CellOutput; sessionId: string; onOpenImage?: (attachmentId: string) => void }) {
  switch (output.kind) {
    case "text":
      return (
        <pre className={cn("m-0 whitespace-pre-wrap break-words px-3 py-1 font-mono text-[0.6875rem] leading-[1.5]", output.stream === "stderr" ? "text-warning" : output.stream === "result" ? "text-foreground" : "text-foreground/80")}>
          {output.text}
          {output.truncated && <span className="text-muted-foreground"> … truncated</span>}
        </pre>
      );
    case "error":
      return (
        <pre className="m-0 whitespace-pre-wrap break-words bg-destructive/10 px-3 py-1.5 font-mono text-[0.6875rem] leading-[1.5] text-destructive">
          {output.ename}: {output.evalue}
          {"\n"}
          {output.traceback.map(stripAnsi).join("\n")}
        </pre>
      );
    case "image": {
      const src = output.attachmentId ? attachmentUrl(sessionId, output.attachmentId) : output.dataB64 ? `data:${output.mediaType};base64,${output.dataB64}` : undefined;
      if (!src) return <p className="px-3 py-1 text-[0.6875rem] text-muted-foreground">[image]</p>;
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="Cell output figure"
          className={cn("mx-3 my-1.5 max-h-80 max-w-full rounded border border-border bg-white", output.attachmentId && onOpenImage && "cursor-zoom-in")}
          onClick={() => output.attachmentId && onOpenImage?.(output.attachmentId)}
        />
      );
    }
    case "dataframe":
      return <DataframeTable output={output} />;
    case "html":
      return <HtmlOutput html={output.html} truncated={output.truncated} />;
    case "json":
      return <pre className="m-0 whitespace-pre-wrap px-3 py-1 font-mono text-[0.6875rem] leading-[1.5]">{JSON.stringify(output.value, null, 2)}</pre>;
    case "clear":
      return null;
  }
}

function DataframeTable({ output }: { output: Extract<CellOutput, { kind: "dataframe" }> }) {
  return (
    <div className="mx-3 my-1.5 max-h-80 overflow-auto rounded border border-border">
      <table className="w-max min-w-full border-collapse font-mono text-[0.6875rem] tabular-nums">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {output.columns.map((column, index) => (
              <th key={column} className="border-b border-border px-2 py-1 text-left font-medium">
                {column}
                <span className="ml-1 font-normal text-muted-foreground">{output.dtypes[index]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {output.rows.map((row, r) => (
            <tr key={r} className="odd:bg-muted/30">
              {row.map((cell, c) => (
                <td key={c} className={cn("whitespace-nowrap px-2 py-0.5", cell === null && "text-muted-foreground/50 italic")}>
                  {cell === null ? "null" : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border bg-muted/40 px-2 py-0.5 text-[0.625rem] text-muted-foreground">
        {output.shape[0]} × {output.shape[1]}{output.truncated ? " · preview" : ""}
      </p>
    </div>
  );
}

/**
 * HTML from a kernel is TRUSTED THE WAY A TERMINAL IS: it is the user's own
 * code running in the user's own environment. Still, it goes in a sandboxed
 * iframe so a `<script>` in a repr cannot reach the cockpit's session.
 */
function HtmlOutput({ html, truncated }: { html: string; truncated?: boolean }) {
  const [height, setHeight] = useState(120);
  return (
    <div className="mx-3 my-1.5">
      <iframe
        sandbox=""
        title="HTML output"
        srcDoc={`<style>body{margin:0;font:11px/1.5 ui-monospace,monospace;color:inherit}table{border-collapse:collapse}td,th{padding:2px 6px;border:1px solid #8884}</style>${html}`}
        className="w-full rounded border border-border bg-white"
        style={{ height }}
        onLoad={(event) => {
          const doc = event.currentTarget.contentDocument;
          if (doc) setHeight(Math.min(480, Math.max(40, doc.body.scrollHeight + 8)));
        }}
      />
      {truncated && <p className="text-[0.625rem] text-muted-foreground">truncated</p>}
    </div>
  );
}
