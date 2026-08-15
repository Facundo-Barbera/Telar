import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A dashed placeholder for empty, first-load-failed, and nothing-here states:
 * centered icon, title, one-line body, and an optional action. Pass
 * `iconClassName` to recolour the icon for error variants.
 *
 * Ported from `apps/web_old/components/common/empty-state.tsx`; see
 * `page-header.tsx` for why `font-heading` is gone.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  iconClassName,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  iconClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center",
        className,
      )}
    >
      <Icon className={cn("size-8 text-muted-foreground/50", iconClassName)} />
      <h2 className="mt-4 text-base font-medium">{title}</h2>
      {description && <div className="mt-1 max-w-md text-sm text-muted-foreground">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
