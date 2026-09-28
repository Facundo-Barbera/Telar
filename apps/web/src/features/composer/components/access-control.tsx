"use client";

import { useState } from "react";
import { ShieldCheckIcon } from "lucide-react";
import type { ProviderDriverKind, RuntimeMode } from "@telar/engine-client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RUNTIME_MODE_HELP, RUNTIME_MODE_LABELS, RUNTIME_MODES } from "@/features/providers";
import { ChoiceRow, ControlTrigger, MenuHeading } from "./control-primitives";

export function AccessControl({
  runtimeMode,
  onRuntimeMode,
  driver,
  resumeAfterRateLimit,
  onResumeAfterRateLimit,
}: {
  runtimeMode: RuntimeMode;
  onRuntimeMode: (mode: RuntimeMode) => void;
  driver?: ProviderDriverKind;
  /** Absent means the driver's default, which is on for Claude. */
  resumeAfterRateLimit?: boolean;
  onResumeAfterRateLimit?: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const mode = RUNTIME_MODE_LABELS[runtimeMode];
  // "Auto" would read the same as the reasoning pill's Auto beside it.
  const label = runtimeMode === "auto" ? "Access" : mode;
  // Claude only: the only provider whose limits the engine can schedule a resume from.
  const limits = driver === "claude" && onResumeAfterRateLimit;
  const resumes = resumeAfterRateLimit ?? true;
  const pick = (run: () => void) => () => {
    run();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<ControlTrigger open={open} icon={<ShieldCheckIcon className="size-3.5" />} label={label} ariaLabel={`Access: ${mode}`} />} />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-2xl p-1.5">
        <MenuHeading>Access</MenuHeading>
        {RUNTIME_MODES.map((option) => (
          <ChoiceRow
            key={option}
            label={RUNTIME_MODE_LABELS[option]}
            description={RUNTIME_MODE_HELP[option]}
            selected={option === runtimeMode}
            onSelect={pick(() => onRuntimeMode(option))}
          />
        ))}
        {limits && (
          <>
            <MenuHeading>Usage limits</MenuHeading>
            <ChoiceRow
              label="Continue after a reset"
              description="A turn stopped by the five-hour or weekly limit runs again once the limit lifts, carrying on where it left off."
              selected={resumes}
              onSelect={pick(() => onResumeAfterRateLimit(true))}
            />
            <ChoiceRow
              label="Stay stopped"
              description="The turn stays failed and shows when the limit resets, with a Resume now button."
              selected={!resumes}
              onSelect={pick(() => onResumeAfterRateLimit(false))}
            />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
