"use client";

import type { ReactNode } from "react";
import { cn } from "@/ui/utils";

export function GroupStrip({
  label,
  count,
  tone = "none",
  actions,
}: {
  label: string;
  count?: number;
  tone?: "none" | "attention";
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 py-2 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
      <span className={cn("min-w-0 truncate", tone === "attention" && "text-warning")}>{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  );
}
