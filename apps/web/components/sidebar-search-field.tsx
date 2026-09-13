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
 * THE CHROME IS THE ROW, NOT THE INPUT, and that is what lets something sit
 * INSIDE the field. It used to be an absolutely-positioned icon over a
 * full-width `Input` with a hand-counted `pl-7`/`pr-10` to keep the text off
 * it — which works for two things of fixed width and for nothing else. Telar's
 * rail needed a scope chip in there, whose width is a project's name, so the
 * row became a flex box wearing the border and the input became bare inside it.
 * Every caller that passes neither slot draws exactly what it drew before.
 *
 * `start` and `end` are the two places the callers diverge: Telar puts its
 * project-scope chip in one and its ⌘K hint / clear button in the other, the
 * Spool passes neither. `start` REPLACES the search glyph rather than sitting
 * beside it — two marks at the head of one field is one too many.
 */
import { forwardRef } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SidebarSearchField = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input> & { start?: React.ReactNode; end?: React.ReactNode }
>(function SidebarSearchField({ start, end, className, ...props }, ref) {
  return (
    <div
      className={cn(
        // The Input's own chrome, moved out one level so the row carries it.
        // `focus-within` rather than `focus-visible`: the thing being focused is
        // now a child, and the border has to notice.
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
