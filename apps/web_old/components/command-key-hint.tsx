import { cn } from "@/lib/utils";

/**
 * The badge a hold-⌘ reveal pins on an element a command key reaches (see
 * lib/command-key-hints.ts for the gesture). One component rather than a
 * class string copied between the sidebar's three hint sites, so the badges
 * cannot drift apart visually. pointer-events-none always: a hint labels a
 * target, it must never become the thing the click lands on.
 */
export function CommandKeyHint({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "pointer-events-none rounded border border-border bg-popover px-1 py-px font-sans text-[10px] font-medium text-foreground/75 shadow-sm",
        className,
      )}
    >
      {label}
    </kbd>
  );
}
