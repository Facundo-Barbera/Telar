"use client";

import { lineRangeReference } from "@/lib/drag-reference";
import type { LineRange } from "../model";

/** Offers selected lines to the message. It never takes focus, so the composer keeps its caret. */
export function LineRangeAction({ path, range, onInsert }: { path: string; range: LineRange; onInsert: (text: string) => void }) {
  const reference = lineRangeReference(path, range);
  return (
    <div className="mx-3 mb-2 flex items-center justify-end">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onInsert(reference.text)}
        title={reference.text}
        className="rounded-md border border-input px-2 py-0.5 text-2xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Add {reference.label} to message
      </button>
    </div>
  );
}
