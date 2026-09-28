"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { carryTokens, highlight, type CarriedLines, type HighlightedLine } from "../highlight";
import { cn } from "@/ui/utils";

export const CODE_GEOMETRY = "font-mono leading-[1.55] tracking-normal";

export const CODE_FONT_SIZE = { fontSize: "var(--app-font-mono-size, 0.6875rem)" } as const;

export function CodeLines({
  lines,
  coloured,
  minRows = 0,
}: {
  lines: readonly string[];
  coloured?: CarriedLines | undefined;
  minRows?: number;
}) {
  return (
    <>
      {Array.from({ length: Math.max(lines.length, minRows) }, (_, index) => {
        const tokens = coloured?.[index];
        const painted = tokens?.some((token) => token.text !== "") ? tokens : undefined;
        return (
          <div key={index}>
            {painted
              ? painted.map((token, at) => (
                  <span key={at} style={token.style as React.CSSProperties}>
                    {token.text}
                  </span>
                ))
              : lines[index] || " "}
          </div>
        );
      })}
    </>
  );
}

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
  const coloured = useMemo(() => (tokenised ? carryTokens(tokenised, value) : undefined), [tokenised, value]);
  const padded = Math.max(lines.length, minRows);

  return (
    <div className={cn("relative min-w-0", className)}>
      <pre aria-hidden data-shiki style={CODE_FONT_SIZE} className={cn("m-0 whitespace-pre px-3 py-2", CODE_GEOMETRY)}>
        <CodeLines lines={lines} coloured={coloured} minRows={padded} />
      </pre>
      <textarea
        style={CODE_FONT_SIZE}
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
