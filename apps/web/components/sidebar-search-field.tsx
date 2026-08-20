"use client";

/**
 * ONE SEARCH FIELD, TWO RAILS — the web pass that put Telar's "Search
 * sessions" and the Spool's "Search the Spool…" through the same chrome.
 *
 * Before this pass the two inputs disagreed on height (h-8 vs h-7), icon
 * size and colour (size-3.5 sidebar-foreground/45 vs size-3
 * muted-foreground/60), text size (text-sm vs text-xs) and background
 * (Telar's transparent-until-hover treatment vs the Spool's default Input
 * chrome) — differences with no behavioural reason, just two components
 * built months apart. BEHAVIOUR STAYS WHERE IT WAS: Telar's ⌘K binding is
 * still wired in `app-sidebar.tsx`, and the Spool's dropdown-on-focus stays
 * in `search.tsx` — this component owns only the shape both share (the
 * icon, the inset, the height, the position at the top of the rail), never
 * the wiring around it.
 *
 * `end` is the one place the two calls diverge visually: Telar reserves it
 * for the ⌘K hint / clear button, the Spool passes nothing. Reserving the
 * padding only when something is there keeps the Spool's field from
 * carrying a right inset nothing occupies.
 */
import { forwardRef } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SidebarSearchField = forwardRef<HTMLInputElement, React.ComponentProps<typeof Input> & { end?: React.ReactNode }>(
  function SidebarSearchField({ end, className, ...props }, ref) {
    return (
      <div className="relative min-w-0">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-sidebar-foreground/45"
          aria-hidden
        />
        <Input
          ref={ref}
          {...props}
          className={cn(
            "h-8 border-transparent bg-transparent pl-7 text-sm shadow-none hover:bg-sidebar-accent/70 focus-visible:border-sidebar-border focus-visible:bg-sidebar-accent/70",
            end && "pr-10",
            className,
          )}
        />
        {end && <div className="absolute top-1/2 right-1 -translate-y-1/2">{end}</div>}
      </div>
    );
  },
);
