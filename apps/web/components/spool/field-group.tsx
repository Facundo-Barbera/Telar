"use client";

/**
 * THE INSET-GROUP GRAMMAR — Apple Reminders' editing idiom, translated to this
 * app's own tokens.
 *
 * THE VERDICT THAT MADE THIS FILE: "too generic, doesn't even fit our UI
 * based on the new Telar sessions… I like Apple Reminders." A centered
 * `Dialog` with stacked labelled `Input`s is a form; a rounded card holding
 * hairline-separated ROWS — quiet label left, control right — is an edit
 * sheet. The Spool's dialogs (`dialogs.tsx`, `add-task.tsx`) wear this now.
 *
 * THE BACKGROUND STEP IS THE SAME ONE THE REST OF THE APP ALREADY USES for
 * "a container inside a card": `bg-muted/40` — the calendar's own rail
 * (`calendar.tsx`), the board's lane columns (`board.tsx`) and the packet's
 * own inset block (`packet-body.tsx`) all step off their card the same way.
 * This is not a new token, only a new shape wrapped around the old one.
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/** A row's own input — borderless, transparent, right-aligned to share a
 *  line with its label. The row's hairline is the only border it needs; a
 *  second bordered box around it would be the ceremony this idiom drops. */
export function RowInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn("h-7 border-none bg-transparent px-0 text-right shadow-none focus-visible:ring-0", className)}
      {...props}
    />
  );
}

/** The rounded, one-step-off-the-sheet container. Rows are its children,
 *  separated by hairlines rather than each carrying its own card. */
export function FieldGroup({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("divide-y divide-border/50 overflow-hidden rounded-xl bg-muted/40", className)}>
      {children}
    </div>
  );
}

/** One row: a quiet small label on the left, the control on the right.
 *  Selects, dates and toggles live IN the row — this is the row, not a
 *  label wrapping an input. */
export function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** Rendered under the row, full width — the rare case a control needs a
   *  sentence of explanation (e.g. the pin day's "shows on the calendar"). */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="shrink-0 text-xs text-muted-foreground">
          {label}
        </label>
        <div className="min-w-0 flex-1 text-right">{children}</div>
      </div>
      {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  );
}
