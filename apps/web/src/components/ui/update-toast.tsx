"use client";

/**
 * THE UPDATER'S OWN TOAST — the whole of it, in one file and with no dependency.
 *
 * WHY NOT A TOAST LIBRARY. Three messages, one anchor, four seconds. `sonner`
 * would bring a portal, a stacking region, a provider to mount at the root and
 * a queue, for news that is never queued: an update is at exactly one point of
 * its life at a time, so the second toast REPLACES the first rather than
 * stacking under it.
 *
 * WHY IT IS ANCHORED AND NOT CORNERED. A screen-corner toast is a notification
 * about something elsewhere; this is a caption on the control the reader is
 * looking at — `absolute bottom-full` over whichever surface is visible, so the
 * sentence and the glyph it explains are the same object. THE PARENT MUST BE
 * POSITIONED (`relative`); both surfaces wrap their control in one.
 *
 * It cannot appear in a browser tab because it is rendered inside a control
 * that only exists where the shell's bridge does.
 */

import { useEffect, useState } from "react";
import { updateToast, type UpdateStatus } from "@/lib/desktop-updates";
import { cn } from "@/lib/utils";

/** Long enough to read eleven words, short enough that nobody dismisses it. */
export const UPDATE_TOAST_MS = 4_000;

export function UpdateToast({
  status,
  className,
  dismissMs = UPDATE_TOAST_MS,
}: {
  status: UpdateStatus;
  className?: string;
  /** Overridden only by tests, which have no four seconds to spend. */
  dismissMs?: number;
}) {
  const toast = updateToast(status);
  const key = toast?.key;
  /**
   * WHICH TOAST HAS BEEN SEEN — not "is it visible".
   *
   * The distinction is the whole mechanism. A `downloading` broadcast arrives
   * many times a second while the percent climbs; a boolean would be re-set by
   * every one of them and the toast would never leave. The key changes only
   * when the NEWS changes, so a dismissed key stays dismissed however often it
   * re-renders, and a new key is visible again without anything resetting it.
   */
  const [dismissed, setDismissed] = useState<string>();

  useEffect(() => {
    if (!key || key === dismissed) return;
    const timer = setTimeout(() => setDismissed(key), dismissMs);
    return () => clearTimeout(timer);
  }, [key, dismissed, dismissMs]);

  if (!toast || key === dismissed) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="update-toast"
      className={cn(
        // POINTER-EVENTS-NONE: it floats over the rail and the settings row,
        // and a caption that ate a click on what is underneath it would be a
        // worse bug than the one it explains.
        "pointer-events-none absolute bottom-full right-0 z-50 mb-2 w-max max-w-56 rounded-md border border-border",
        "bg-popover px-2 py-1 text-xs text-popover-foreground shadow-3",
        "animate-in fade-in-0 slide-in-from-bottom-1",
        className,
      )}
    >
      {toast.message}
    </div>
  );
}
