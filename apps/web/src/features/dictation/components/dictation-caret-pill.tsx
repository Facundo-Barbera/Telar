"use client";

import { createPortal } from "react-dom";
import { MicIcon } from "lucide-react";
import { languageBadge } from "../language-label";
import { cn } from "@/lib/utils";

const LIFT_PX = 6;
const NUDGE_PX = 4;
const PILL_HEIGHT_PX = 20;
const PILL_MAX_WIDTH_PX = 80;
const MARGIN_PX = 4;

// Portalled to body in viewport coordinates: inside the editable it would corrupt the draft, inside the composer it would be clipped.
export function DictationCaretPill({ rect, language, className }: { rect: DOMRect; language: string; className?: string }) {
  if (typeof document === "undefined") return null;

  const top = Math.max(rect.top - LIFT_PX - PILL_HEIGHT_PX, MARGIN_PX);
  const left = Math.min(Math.max(rect.left - NUDGE_PX, MARGIN_PX), Math.max(window.innerWidth - PILL_MAX_WIDTH_PX, MARGIN_PX));

  return createPortal(
    <span
      aria-hidden
      data-slot="dictation-caret-pill"
      style={{ top, left }}
      className={cn(
        "pointer-events-none fixed z-50 flex select-none items-center gap-1 rounded-full bg-primary px-2 py-0.5",
        "text-primary-foreground shadow-sm",
        className,
      )}
    >
      <MicIcon className="size-3 animate-pulse" />
      <span className="font-medium text-3xs leading-4 tracking-wide">{languageBadge(language)}</span>
    </span>,
    document.body,
  );
}
