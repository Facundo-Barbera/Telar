"use client";

/**
 * THE TEXTAREA-OVER-SHIKI EDITOR, on its own.
 *
 * Extracted from `file-view-surface.tsx` so a notebook cell and a file share
 * one editor: same tokenizer as the transcript, same geometry, same caret
 * illusion. The file view kept its gutter, its save coordinator and its
 * banners; this is only the two stacked layers and the debounced highlight.
 *
 * IDENTICAL GEOMETRY ON BOTH LAYERS, OR THE CARET DRIFTS — see `CODE_GEOMETRY`.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { highlight, type HighlightedLine } from "@/lib/highlight";
import { cn } from "@/lib/utils";

export const CODE_GEOMETRY = "font-mono text-[0.6875rem] leading-[1.55] tracking-normal";

export function OverlayEditor({
  value,
  onChange,
  language,
  readOnly = false,
  ariaLabel,
  onKeyDown,
  minRows = 1,
  className,
  autoFocus,
}: {
  value: string;
  onChange?: (next: string) => void;
  language?: string;
  readOnly?: boolean;
  ariaLabel: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  minRows?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const [tokenised, setTokenised] = useState<{ of: string; lines: HighlightedLine[] }>();
  const lines = useMemo(() => value.split("\n"), [value]);

  useEffect(() => {
    let cancelled = false;
    const task = window.setTimeout(() => {
      void highlight(value, language).then((result) => {
        if (!cancelled && result) setTokenised({ of: value, lines: result });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [value, language]);
  const coloured = tokenised && tokenised.of === value ? tokenised.lines : undefined;
  const padded = Math.max(lines.length, minRows);

  return (
    <div className={cn("relative min-w-0", className)}>
      <pre aria-hidden data-shiki className={cn("m-0 whitespace-pre px-3 py-2", CODE_GEOMETRY)}>
        {Array.from({ length: padded }, (_, index) => (
          <div key={index}>
            {coloured?.[index]
              ? coloured[index].map((token, at) => (
                  <span key={at} style={token.style as React.CSSProperties}>
                    {token.text}
                  </span>
                ))
              : lines[index] || " "}
          </div>
        ))}
      </pre>
      <textarea
        value={value}
        readOnly={readOnly || !onChange}
        spellCheck={false}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute inset-0 h-full w-full resize-none overflow-hidden whitespace-pre border-0 bg-transparent px-3 py-2 text-transparent caret-foreground outline-none",
          CODE_GEOMETRY,
          "selection:bg-primary/30 selection:text-transparent",
          (readOnly || !onChange) && "cursor-default",
        )}
      />
    </div>
  );
}
