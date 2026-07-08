import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

// The page chrome every top-level surface repeats: sidebar trigger, a hairline,
// an optional leading slot (e.g. a back link), the title + muted description,
// and a right-aligned actions cluster. Keeps headers reading as one system.
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
        "flex shrink-0 items-center gap-3 border-b px-4 py-3",
        className,
      )}
    >
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-4" />
      {leading}
      <div className="min-w-0 flex-1 space-y-0.5">
        <h1 className="truncate font-heading text-base font-semibold tracking-tight">
          {title}
        </h1>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
