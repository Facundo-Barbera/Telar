"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const DICTATION_NOTICE_MS = 6_000;

/** A refusal, anchored over the mic button and gone by itself. Needs a `relative` parent. */
export function DictationNotice({
  error,
  className,
  dismissMs = DICTATION_NOTICE_MS,
}: {
  error: { text: string; seq: number } | undefined;
  className?: string;
  dismissMs?: number;
}) {
  // Keyed by `seq`, so a second refusal with the same sentence shows again.
  const [dismissed, setDismissed] = useState<number>();
  const seq = error?.seq;

  useEffect(() => {
    if (seq === undefined || seq === dismissed) return;
    const timer = setTimeout(() => setDismissed(seq), dismissMs);
    return () => clearTimeout(timer);
  }, [seq, dismissed, dismissMs]);

  if (!error || seq === dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="dictation-notice"
      className={cn(
        "pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-max max-w-64 rounded-md border border-border",
        "bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-3",
        "animate-in fade-in-0 slide-in-from-bottom-1",
        className,
      )}
    >
      {error.text}
    </div>
  );
}
