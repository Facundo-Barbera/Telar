"use client";

// MARKER — the dashed system-event line inside a transcript.
//
// STATE, NEVER PROSE. This is the rule the primitive exists to carry, and it is
// the one that will be broken first. A marker says what HAPPENED, in a terse
// machine voice, as a clause: "nodes spawned · 4", "parked — waiting on you",
// "recompile #1 (bounded 1 of 2) · audited". It is never a sentence addressed to
// the user, never an explanation, never an apology, never a call to action. If
// the copy would read naturally after "Hi —", it does not belong in a Marker;
// it belongs in a turn.
//
// Color is a quiet state signal, never a highlighter (components/looms/status.tsx
// states the same rule for badges). `attention` swaps the border and text to the
// amber pair and prefixes an alert glyph; everything else stays neutral. There is
// no danger variant on purpose — a marker reports state, and a real failure is a
// turn's business, not a divider's.
//
// CONSOLIDATION, NOT INVENTION: three implementations of this idea already lived
// in the demo gallery (birth/chat.tsx, loom-detail/session.tsx,
// loom-detail/thread.tsx). This ships loom-detail/session.tsx's shape — the
// centred pill flanked by two hairline rules — with thread.tsx's content
// discipline. Production had none, which is why it is here.

import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Marker({
  children,
  attention,
  className,
}: {
  children: ReactNode;
  attention?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 py-0.5", className)}>
      <span className="h-px flex-1 bg-border" />
      <span
        className={cn(
          "flex max-w-[80%] items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-center font-mono text-[9px]",
          attention
            ? "border-amber-600/40 text-amber-600 dark:text-amber-400"
            : "border-border text-muted-foreground",
        )}
      >
        {attention && <CircleAlertIcon className="size-3" />}
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
