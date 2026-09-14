"use client";

/**
 * ASK ONE THING — a small anchored popover-card, replacing `window.prompt`.
 *
 * WHY NOT A CENTERED DIALOG FOR A ONE-FIELD ASK. Renaming an area or naming a
 * retirement reason is a single word or sentence answered where the click
 * happened; a modal that recenters the whole screen for one input is the
 * "generic, doesn't fit our UI" ceremony the Reminders idiom drops. Commit is
 * light: Enter submits, Escape (or an outside click — the popover's own law)
 * cancels, and there is no button unless a refusal needs somewhere to sit.
 *
 * ANCHORED AT THE INVOCATION POINT, meaning the row that was acted on — not
 * the cursor a context menu closed under. The caller passes a ref to that
 * row; Base UI's popover positioner tracks it directly, no wrapper trigger
 * needed since open/close is already state the caller owns (a context-menu
 * click, not a hover or a focus).
 */
import { useState, type RefObject } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

export function AskOneThing({
  open,
  onOpenChange,
  anchor,
  label,
  placeholder,
  initialValue = "",
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row this ask belongs to — never the ephemeral context-menu click. */
  anchor: RefObject<Element | null> | Element | null;
  label: string;
  placeholder?: string;
  initialValue?: string;
  /** The STORE's sentence, rendered in place. Never invented here. */
  error?: string | null;
  onSubmit: (value: string) => void;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <PopoverPrimitive.Popup
            data-slot="ask-one-thing"
            className={cn(
              "w-64 origin-(--transform-origin) rounded-xl bg-popover p-2 text-sm text-popover-foreground shadow-3 ring-1 ring-foreground/10 outline-hidden duration-100",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            {/* Mounted fresh per open, same reasoning `LaneForm`/`AddTaskForm`
                already carry: state that resets when the ask opens IS a
                component whose lifetime is the ask's. */}
            {open && (
              <AskOneThingForm
                label={label}
                {...(placeholder === undefined ? {} : { placeholder })}
                initialValue={initialValue}
                error={error ?? null}
                onSubmit={onSubmit}
                onCancel={() => onOpenChange(false)}
              />
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function AskOneThingForm({
  label,
  placeholder,
  initialValue,
  error,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder?: string;
  initialValue: string;
  error: string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <label className="block px-1 text-2xs font-medium text-muted-foreground">{label}</label>
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
          }
        }}
        placeholder={placeholder}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {/* No buttons — Enter commits, Escape or an outside click cancels. A
          refusal is the one thing that earns a line here. */}
      {error && <p className="px-1 text-xs break-words text-muted-foreground">{error}</p>}
    </form>
  );
}
