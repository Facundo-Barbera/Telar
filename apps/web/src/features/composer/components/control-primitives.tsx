"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/ui/utils";

// Nothing inside the composer's InputGroup may carry `disabled`: its `has-disabled:opacity-50` greys the whole box.
function controlClass(open: boolean, disabled?: boolean) {
  return cn(
    "flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-transparent px-2 text-xs font-medium text-muted-foreground transition-colors",
    !disabled && "hover:bg-accent hover:text-foreground",
    disabled && "opacity-70",
    open && "bg-accent text-foreground",
  );
}

export function ControlDivider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border" />;
}

type ControlTriggerProps = ComponentPropsWithoutRef<"button"> & {
  open: boolean;
  icon: ReactNode;
  label: string;
  /** Shown only while the row is folded, so a folded pill's value stays visible. */
  detail?: string;
  ariaLabel: string;
  /** The label is the provider's default rather than a pick. */
  muted?: boolean;
};

export const ControlTrigger = forwardRef<HTMLButtonElement, ControlTriggerProps>(
  ({ open, icon, label, detail, ariaLabel, muted, className, ...props }, ref) => (
    <button {...props} ref={ref} type="button" className={cn(controlClass(open, props.disabled), className)} aria-label={ariaLabel}>
      <span className="flex shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span className={cn("max-w-48 truncate", muted ? "text-muted-foreground" : "text-foreground")}>{label}</span>
      {detail ? (
        <>
          <span className="text-muted-foreground/40 @2xl/composer:hidden">·</span>
          <span className="max-w-24 truncate @2xl/composer:hidden">{detail}</span>
        </>
      ) : null}
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  ),
);
ControlTrigger.displayName = "ControlTrigger";

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

export function CompactRow({
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
        disabled && "cursor-default opacity-60",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-3xs text-muted-foreground">{hint}</span>}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {selected && <CheckIcon className="size-3.5 text-primary" />}
      </span>
    </button>
  );
}

export function ChoiceRow({
  label,
  description,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/60",
        disabled && "cursor-default opacity-60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>}
      </span>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {selected && <CheckIcon className="size-3.5 text-primary" />}
      </span>
    </button>
  );
}
