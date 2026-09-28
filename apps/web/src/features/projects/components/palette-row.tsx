"use client";

import { cn } from "@/ui/utils";

export function PaletteRow({
  id,
  on,
  dim,
  onPick,
  onHover,
  glyph,
  title,
  hint,
  mono,
  badge,
  key9,
  trailing,
}: {
  id: string;
  on: boolean;
  dim?: boolean;
  onPick: () => void;
  onHover: () => void;
  glyph: React.ReactNode;
  title: string;
  hint?: string;
  mono?: boolean;
  badge?: React.ReactNode;
  key9?: number;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={on}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
        dim && "opacity-60",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{title}</span>
          {badge}
        </span>
        {hint && (
          <span className={cn("block truncate text-2xs text-muted-foreground", mono && "font-mono")}>{hint}</span>
        )}
      </span>
      {key9 !== undefined && <kbd className="shrink-0 font-sans text-3xs text-muted-foreground/60">⌘{key9}</kbd>}
      {trailing}
    </button>
  );
}
