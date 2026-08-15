import type { ReactNode } from "react";
import { MainSidebarTrigger } from "@/components/main-sidebar-trigger";
import { cn } from "@/lib/utils";

/**
 * The page chrome every top-level surface repeats: sidebar trigger, a hairline,
 * an optional leading slot, the title plus muted description, and a
 * right-aligned actions cluster. Keeps headers reading as one system.
 *
 * Ported from `apps/web_old/components/common/page-header.tsx`.
 *
 * > **Deviation: no `font-heading`.** The donor had a separate heading family
 * > token. This app ships one family (Geist) and its stylesheet declares no
 * > `--font-heading`, so the class would resolve to nothing — a silent no-op
 * > that reads like a style. Weight and tracking carry the hierarchy instead.
 */
export function PageHeader({
  title,
  description,
  actions,
  leading,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        // A consistent floor (h-14) so a title-only header matches a
        // title+description one; min- (not fixed) lets a rich header grow
        // instead of clipping its text.
        "flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2",
        className,
      )}
    >
      <MainSidebarTrigger />
      {leading}
      <div className="min-w-0 flex-1 space-y-0.5">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}
