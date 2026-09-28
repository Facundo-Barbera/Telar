import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/ui/utils";

export type PanelTone = "none" | "active" | "attention" | "danger" | "done" | "info";

export function PanelHeader({
  icon,
  label,
  count,
  tone = "none",
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  icon?: ReactNode;
  label: string;
  count?: number;
  tone?: PanelTone;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase",
        className,
      )}
      {...props}
    >
      {icon && (
        <span
          className={cn(
            "flex shrink-0 [&_svg]:size-3.5",
            tone === "attention" && "text-warning",
            tone === "danger" && "text-destructive",
            tone === "done" && "text-success",
            tone === "active" && "text-primary",
            tone === "info" && "text-info",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  );
}

export function PanelRow({ active, className, ...props }: ComponentProps<"div"> & { active?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2 px-3 py-2 pl-4 text-sm",
        active && "bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

export function PanelEmpty({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "gap-1 px-3 py-6" : "gap-1.5 px-4 py-10")}>
      {icon && <span className="text-muted-foreground/60 [&_svg]:size-5">{icon}</span>}
      <p className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{title}</p>
      {children && <p className={cn("max-w-64 text-muted-foreground", compact ? "text-2xs" : "text-xs")}>{children}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function PanelSectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
    </div>
  );
}

export function PanelDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
