import type { ReactNode } from "react";
import { MainSidebarTrigger, useMainIsLeftmost } from "@/ui/main-sidebar-trigger";
import { cn } from "@/ui/utils";

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
  const mainIsLeftmost = useMainIsLeftmost();

  return (
    <header
      className={cn(
        "app-drag flex min-h-[var(--titlebar-height)] shrink-0 items-center gap-3 border-b py-2 pr-4 md:h-[var(--titlebar-band-height)] md:min-h-[var(--titlebar-band-height)] md:py-0",
        mainIsLeftmost ? "pl-[max(16px,calc(var(--titlebar-inset)+var(--app-island-inset)))]" : "pl-4",
        className,
      )}
    >
      <MainSidebarTrigger />
      {leading && <div className="app-no-drag flex shrink-0 items-center gap-2">{leading}</div>}
      <div className="min-w-0 flex-1 space-y-0.5">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="app-no-drag flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}
