"use client";

import { useEffect, useState } from "react";
import { updateToast, type UpdateStatus } from "../desktop-updates";
import { cn } from "@/ui/utils";

export const UPDATE_TOAST_MS = 4_000;

export function UpdateToast({
  status,
  className,
  dismissMs = UPDATE_TOAST_MS,
}: {
  status: UpdateStatus;
  className?: string;
  dismissMs?: number;
}) {
  const toast = updateToast(status);
  const key = toast?.key;
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
