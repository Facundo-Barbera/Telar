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
 * it — which works for two things of fixed width and for nothing else. The row
 * is a flex box wearing the border and the input is bare inside it, so a slot's
 * content may be any width. Every caller that passes no slot draws exactly what
 * it drew before.
 *
 * ONE SLOT, NOT TWO. There was a `start` as well, added for Telar's
 * project-scope chip, which REPLACED the search glyph rather than sitting
 * beside it. #400 removed that chip and no caller passes a leading anything, so
 * the slot went with it: an unused prop on a shared primitive is a shape three
 * rails have to keep agreeing about for nobody's sake. `end` stays — Telar's ⌘K
 * hint and clear button live there, and the Spool and the settings nav pass
 * neither.
 */
import { forwardRef } from "react";
import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SidebarSearchField = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input> & { end?: React.ReactNode }
>(function SidebarSearchField({ end, className, ...props }, ref) {
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
      <SearchIcon className="pointer-events-none size-3.5 shrink-0 text-sidebar-foreground/45" aria-hidden />
      <Input
        ref={ref}
        {...props}
        className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
      />
      {end}
    </div>
  );
});
