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

export const CODE_GEOMETRY = "font-mono leading-[1.55] tracking-normal";

/**
 * THE FONT SIZE, AS AN INLINE STYLE — and it has to be, which is the whole
 * point of this constant.
 *
 * globals.css carries `code, pre, kbd, samp { font-size: var(--app-font-mono-size) }`
 * so the reader's "code a notch smaller" preference reaches every element that
 * actually holds code. That rule is UNLAYERED, and unlayered CSS beats anything
 * in `@layer utilities` — so a `text-[0.6875rem]` class on the `<pre>` loses to
 * it while the same class on the `<textarea>` and on the gutter (neither is a
 * `pre`) wins. The layers then disagree: measured in the panel, the coloured
 * text was drawing at 13px/20.15px while the invisible text the caret follows
 * was at 11px/17.05px, so the caret and the glyphs drifted apart by three
 * pixels a line — half a line by line ten, four lines by line forty — and the
 * gutter numbered lines it no longer sat beside.
 *
 * An inline style is the one place in the cascade that wins on all three, so
 * all three take the SAME size, and the preference is still honoured because
 * this is the same variable that rule reads. The fallback is what the code
 * layer used to claim before the preference existed.
 */
export const CODE_FONT_SIZE = { fontSize: "var(--app-font-mono-size, 0.6875rem)" } as const;

/**
 * THE COLOURED LAYER'S LINES — one `<div>` per SOURCE line, always.
 *
 * A BLANK LINE STILL HAS TO OCCUPY A LINE BOX, and this is the whole reason
 * this is a component rather than three lines inlined twice. Shiki hands back an
 * EMPTY TOKEN ARRAY for a blank line, and `[]` is truthy — so the highlighted
 * branch used to draw `<div></div>`, which has no inline content and therefore
 * no height. Every blank line in a Python file collapsed the moment the colours
 * landed: the code slid up under a gutter that had not moved, the caret in the
 * textarea above pointed at the wrong line, and the height those lines were owed
 * reappeared as dead space at the end of the file — which is why this read as
 * "my blank lines moved to the bottom" rather than as a rendering bug.
 *
 * The plain branch never had it, because it already substituted a space. So the
 * rule is one rule for both: a line with nothing VISIBLE in it draws that same
 * space, coloured or not. Nothing here touches the text — the textarea holds the
 * source, and this layer only paints under it.
 */
export function CodeLines({
  lines,
  coloured,
  /** Draw at least this many lines, so a one-line cell is still a box you can
   *  aim at. Never fewer than the source has. */
  minRows = 0,
}: {
  lines: readonly string[];
  coloured?: readonly HighlightedLine[] | undefined;
  minRows?: number;
}) {
  return (
    <>
      {Array.from({ length: Math.max(lines.length, minRows) }, (_, index) => {
        const tokens = coloured?.[index];
        // `some`, not `length`: a grammar may emit a single empty token for a
        // line, which draws exactly as nothing does.
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
  const coloured = tokenised && tokenised.of === value ? tokenised.lines : undefined;
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
