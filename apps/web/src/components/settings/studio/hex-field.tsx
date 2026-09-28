"use client";

/**
 * THE HEX, TYPEABLE — the one text field every colour on this pane is editable
 * through.
 *
 * `<input type="color">` cannot accept a pasted `#1e1e2e`, and building a
 * palette through 32 OS colour dialogs was the old editor's worst chore. The
 * field holds free text while focused and commits on Enter or blur — only a
 * colour lands; anything else snaps back.
 *
 * IT LIVES BESIDE THE TOOLS RATHER THAN IN THEM (#471) because the gradient
 * stops want the same field, and a stop's colour field that behaved differently
 * from the token rows' — accepting a different set of shapes, committing at a
 * different moment — would be the pane teaching two answers to "how do I type a
 * colour here?".
 *
 * WHAT IT ACCEPTS is lib/colour-field.ts's business, which is wider than hex:
 * `#abc`, `#1e1e2e`, `oklch(0.68 0.16 264)`, `rgb(20 20 20)`, and any of them
 * with the `#` left off. What it COMMITS is always normalised `#rrggbb`, so
 * every caller can put the result straight into a swatch.
 */

import { useState } from "react";
import { normaliseColourText } from "@/lib/colour-field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function HexField({
  value,
  label,
  className,
  live = false,
  onCommit,
}: {
  value: string;
  label: string;
  className?: string;
  /**
   * COMMIT AS IT IS TYPED, the moment the text is a colour — "typing a hex
   * updates the stop live" (#471). It is the gradient stop's setting rather
   * than everybody's: a stop is a thing you are LOOKING at while you type, so
   * seeing it move is the point, and the sliders beside it already behave this
   * way. The sixteen token rows are the other case — sixteen values you are
   * mostly not looking at, half of them tiny — and there the value that lands
   * should be the one you finished typing, not `#11ee11` on the way to
   * `#1e1e2e`.
   */
  live?: boolean;
  onCommit: (hex: string) => void;
}) {
  // `text` only means anything while focused — display falls back to `value`
  // otherwise, so no effect has to chase external changes.
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const commit = () => {
    setEditing(false);
    const hex = normaliseColourText(text);
    if (hex) onCommit(hex);
    else setText(value);
  };
  return (
    <Input
      value={editing ? text : value}
      aria-label={`${label} hex value`}
      spellCheck={false}
      className={cn("h-6 w-[4.75rem] shrink-0 px-1.5 font-mono text-3xs tabular-nums", className)}
      onFocus={() => {
        setEditing(true);
        setText(value);
      }}
      onChange={(event) => {
        setText(event.target.value);
        if (!live) return;
        const hex = normaliseColourText(event.target.value);
        if (hex) onCommit(hex);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          setEditing(false);
          setText(value);
        }
      }}
    />
  );
}
