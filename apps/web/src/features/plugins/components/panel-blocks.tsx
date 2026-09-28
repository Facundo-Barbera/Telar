"use client";

import type { PluginPanelBlock } from "@telar/engine-client";
import { MessageResponse } from "@/ui/message";
import { cn } from "@/ui/utils";

type Cell = string | number | boolean | null;

const cellText = (value: Cell) => (value === null ? "—" : String(value));

export function PluginBlocks({
  blocks,
  pending,
  onAction,
}: {
  blocks: readonly PluginPanelBlock[];
  pending?: number;
  onAction: (block: Extract<PluginPanelBlock, { type: "action" }>, index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return (
              <h3 key={index} className="font-heading text-sm font-medium">
                {block.text}
              </h3>
            );
          case "text":
            return block.markdown ? (
              <MessageResponse key={index} className="text-xs">
                {block.text}
              </MessageResponse>
            ) : (
              <p key={index} className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {block.text}
              </p>
            );
          case "keyValue":
            return (
              <dl key={index} className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                {block.items.map((item, row) => (
                  <div key={row} className="contents">
                    <dt className="text-muted-foreground">{item.key}</dt>
                    <dd className="min-w-0 truncate font-mono">{cellText(item.value)}</dd>
                  </div>
                ))}
              </dl>
            );
          case "table":
            return (
              <div key={index} className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left">
                      {block.columns.map((column, col) => (
                        <th key={col} className="px-2 py-1 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border last:border-0">
                        {block.columns.map((_, col) => (
                          <td key={col} className="px-2 py-1 font-mono">
                            {cellText(row[col] ?? null)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "log":
            return (
              <pre
                key={index}
                role="log"
                className="max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap"
              >
                {block.lines.join("\n")}
              </pre>
            );
          case "action":
            return (
              <button
                key={index}
                type="button"
                disabled={pending !== undefined}
                onClick={() => {
                  if (block.confirm && !window.confirm(block.confirm)) return;
                  onAction(block, index);
                }}
                className={cn(
                  "self-start rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted/60 disabled:opacity-50",
                  pending === index && "animate-pulse",
                )}
              >
                {block.label}
              </button>
            );
        }
      })}
    </div>
  );
}
