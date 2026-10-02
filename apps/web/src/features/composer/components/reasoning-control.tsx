"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, GaugeIcon } from "lucide-react";
import type { ProviderDriverKind } from "@telar/engine-client";
import { choiceOf, effortLabel, type ModelChoice, windowSuffix, useModelCatalogue } from "@/features/providers";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Badge } from "@/ui/badge";
import { cn } from "@/ui/utils";
import { modelOptionSections, reasoningPillLabel, selectionOf, type ModelOptionRow } from "../model-options";
import { ControlTrigger, MenuHeading } from "./control-primitives";

const ROWS = "[data-option-row]:not([disabled])";

/** The model's options in one popover: reasoning, context window, fast mode and service tier, where the model has them. */
export function ReasoningControl({
  driver,
  choice,
  instanceId,
  onChange,
  ultrathink,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  instanceId?: string;
  onChange?: (next: ModelChoice) => void;
  /** The draft's keyword; absent where there is no message, and then Ultrathink is not offered. */
  ultrathink?: { active: boolean; toggle: () => void };
}) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const catalogue = useModelCatalogue(driver, instanceId);
  const models = catalogue?.models ?? [];
  const { row, defaultEffort, window: activeWindow, windows } = selectionOf(models, choice);
  const sections = modelOptionSections(driver, models, choice, ultrathink ? { ultrathink: { active: ultrathink.active } } : {});
  const readOnly = !onChange;
  const suffix = windowSuffix(activeWindow, windows);
  const { label, isDefault } = reasoningPillLabel(choice.effort, defaultEffort, suffix, choice.ultracode);
  const spoken = choice.ultracode
    ? "Ultracode"
    : choice.effort
      ? effortLabel(choice.effort)
      : defaultEffort
        ? `${effortLabel(defaultEffort)} (default)`
        : "Auto";
  const tier = choice.serviceTier ? row?.serviceTiers?.find((entry) => entry.id === choice.serviceTier)?.name ?? choice.serviceTier : undefined;
  const detail = [choice.fastMode ? "Fast" : undefined, tier].filter(Boolean).join(" · ");

  useEffect(() => {
    if (!open) return;
    const task = window.setTimeout(() => {
      const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(ROWS) ?? [])];
      (rows.find((button) => button.dataset.selected === "true") ?? rows[0])?.focus();
    }, 0);
    return () => window.clearTimeout(task);
  }, [open]);

  // No pill once the catalogue says there is nothing to set, unless an option is already on the session.
  const picked = Object.keys(choiceOf(choice)).some((key) => key !== "model");
  if (catalogue && row && sections.length === 0 && !picked) return null;

  const choose = (option: ModelOptionRow) => {
    if (option.ultrathink) ultrathink?.toggle();
    else if (option.apply) onChange?.(option.apply(choice));
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(ROWS) ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === "ArrowDown" ? (at + 1) % rows.length
      : event.key === "ArrowUp" ? (at - 1 + rows.length) % rows.length
      : event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : undefined;
    if (to === undefined || rows.length === 0) return;
    event.preventDefault();
    rows[to]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<GaugeIcon className="size-3.5" />}
            label={label}
            {...(isDefault && defaultEffort ? { title: "The model's default. Pick a level to change it." } : {})}
            {...(detail ? { detail } : {})}
            ariaLabel={`Reasoning effort: ${spoken}${suffix ? `, ${suffix} context` : ""}`}
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="max-h-[min(30rem,70vh)] w-72 gap-0 overflow-y-auto rounded-xl p-1">
        <div ref={list} role="group" aria-label="Model options" onKeyDown={onKeyDown}>
          {sections.map((section, index) => (
            <div key={section.id} className={cn(index > 0 && "mt-1 border-t border-border pt-1")} role="group" aria-label={section.title}>
              <MenuHeading>{section.title}</MenuHeading>
              {section.rows.map((option) => (
                <OptionRow key={option.key} option={option} disabled={readOnly || option.disabled === true} onSelect={() => choose(option)} />
              ))}
            </div>
          ))}
          {sections.length === 0 && catalogue?.message && (
            <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{catalogue.message}</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OptionRow({ option, disabled, onSelect }: { option: ModelOptionRow; disabled: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-option-row=""
      data-selected={option.selected ? "true" : "false"}
      aria-pressed={option.selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        option.selected ? "bg-accent" : "hover:bg-accent/60 focus-visible:bg-accent/60",
        disabled && "cursor-default opacity-60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{option.label}</span>
          {option.isDefault && <Badge variant="outline" className="h-4 px-1 text-3xs font-normal text-muted-foreground">Default</Badge>}
        </span>
        {option.description && <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{option.description}</span>}
      </span>
      <span className="flex size-3.5 shrink-0 items-center justify-center pt-0.5">
        {option.selected && <CheckIcon className="size-3.5 text-primary" />}
      </span>
    </button>
  );
}
