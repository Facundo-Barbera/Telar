"use client";

import { effortLabel, ProviderIcon, PROVIDER_LABEL } from "@/features/providers";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { useModelPicker, type ModelPickerProps } from "../hooks/use-model-picker";
import { ControlTrigger } from "./control-primitives";
import { ModelPickerList, ModelPickerRail } from "./model-picker-list";

/** The model pill. The provider is fixed once the session exists; a model change applies from the next turn. */
export function AgentControl(props: ModelPickerProps) {
  const { driver, choice, onChange, onDriverChange } = props;
  const picker = useModelPicker(props);
  const { open, label, models, catalogue, defaultEffort } = picker;
  const readOnly = !onChange;
  const effort = choice.effort ?? defaultEffort;

  return (
    <Popover open={open} onOpenChange={(next: boolean) => (next ? picker.setOpen(true) : picker.close(driver))}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<ProviderIcon provider={driver} size={14} />}
            label={label}
            {...(effort ? { detail: effortLabel(effort) } : {})}
            ariaLabel={`Model: ${label} on ${PROVIDER_LABEL[driver]}`}
            className="min-w-0 max-w-56 justify-start"
          />
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        // A fixed size on every provider and view, so switching the rail never reshapes the box under the pointer.
        className="h-[min(26rem,70vh)] w-[22rem] flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="flex min-h-0 flex-1">
          {!picker.searching && <ModelPickerRail picker={picker} driver={driver} {...(onDriverChange ? { onDriverChange } : {})} />}
          <ModelPickerList picker={picker} driver={driver} choice={choice} readOnly={readOnly} canSwitch={Boolean(onDriverChange)} />
        </div>
        <p className="border-t border-border px-2.5 py-1.5 text-2xs leading-snug text-muted-foreground">
          {readOnly ? "Chosen when the session starts." : onDriverChange ? "Applies to the first message." : "Takes effect next turn."}
          {catalogue?.source === "builtin" && models.some((row) => row.source !== "user") ? " Built-in list." : ""}
          {models.some((row) => row.source === "user") ? " Includes models you added." : ""}
        </p>
      </PopoverContent>
    </Popover>
  );
}
