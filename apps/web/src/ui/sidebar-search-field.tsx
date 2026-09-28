"use client";

import { forwardRef } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/ui/input";
import { cn } from "@/ui/utils";

export const SidebarSearchField = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input> & { start?: React.ReactNode; end?: React.ReactNode }
>(function SidebarSearchField({ start, end, className, ...props }, ref) {
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2 transition-colors",
        "hover:bg-sidebar-accent/70 focus-within:border-sidebar-border focus-within:bg-sidebar-accent/70",
        className,
      )}
    >
      {start ?? <SearchIcon className="pointer-events-none size-3.5 shrink-0 text-sidebar-foreground/45" aria-hidden />}
      <Input
        ref={ref}
        {...props}
        className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
      />
      {end}
    </div>
  );
});
