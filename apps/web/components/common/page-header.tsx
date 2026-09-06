import type { ReactNode } from "react";
import { MainSidebarTrigger, useMainIsLeftmost } from "@/components/main-sidebar-trigger";
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
  /**
   * IS THIS HEADER THE WINDOW'S LEFT EDGE RIGHT NOW?
   *
   * SAFE TO ASK HERE, and `main-sidebar-trigger.tsx` explains why that is not
   * automatic: the inset belongs to whichever element actually sits at x=0, and
   * Settings has a 240px nav of its own to the left of its header — so a
   * component that assumed "rail hidden ⇒ I am the left edge" inset the wrong
   * pane there. This component is used only by surfaces that ARE the left edge
   * when the rail is gone; Settings has its own header and does not use it.
   */
  const mainIsLeftmost = useMainIsLeftmost();

  return (
    <header
      className={cn(
        /**
         * THE SHELL'S OWN TITLEBAR, and until now this header did not know it.
         * `apps/desktop` opens the window with `titleBarStyle: "hiddenInset"`,
         * which leaves the three macOS traffic lights floating over whatever
         * the page draws at the top-left — so with the rail hidden they sat
         * directly on top of the title. The cockpit and the rail had both
         * reserved room for years; this header never had, and the Spool is
         * where that showed.
         *
         * `--titlebar-height` RATHER THAN A LITERAL `h-14`. Same 56px, but the
         * lights are parked at a fixed point derived from that number in
         * `apps/desktop/window-chrome.js` — so every pane that can be the left
         * edge has to agree on it, and agreeing by coincidence is how they
         * drifted 6px apart last time.
         */
        // Same 16px shorter on `md` as the rail's header and the session
        // masthead (both islands start 8px down and the lights do not move), so
        // every header sitting beside the rail reads at one height.
        "app-drag flex min-h-[var(--titlebar-height)] shrink-0 items-center gap-3 border-b py-2 pr-4 md:h-[calc(var(--titlebar-height)-1rem)] md:min-h-[calc(var(--titlebar-height)-1rem)] md:py-0",
        // The content island sits 8px in from the window edge (app-shell.tsx).
        mainIsLeftmost ? "pl-[max(1rem,calc(var(--titlebar-inset)+0.5rem))]" : "pl-4",
        className,
      )}
    >
      <MainSidebarTrigger />
      {/**
       * EVERY INTERACTIVE CHILD OF A DRAG REGION NEEDS `app-no-drag`, and
       * globals.css calls this "the single failure mode of this whole feature,
       * and it is silent": a button inside a drag region does not receive
       * clicks at all — it moves the window instead. Both slots are wrapped
       * rather than each caller being trusted to remember, because the callers
       * pass arbitrary nodes and the one that forgets produces a control that
       * looks fine and does nothing.
       */}
      {leading && <div className="app-no-drag flex shrink-0 items-center gap-2">{leading}</div>}
      <div className="min-w-0 flex-1 space-y-0.5">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="app-no-drag flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}
