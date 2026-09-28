import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PANEL GRAMMAR — the device that makes Telar read as one instrument.
 *
 * Every region in the frozen app is a bordered panel introduced by the same
 * header: an icon, a MONO UPPERCASE label, and a count. Rows inside say their
 * state in words, never with a coloured stripe. It is a small vocabulary and it is used everywhere — the dashboard's `NEEDS YOU 2`, the
 * conversation's `SUB-AGENTS ●1`, the workspace's `DESK 0` — which is exactly
 * why the app feels composed rather than assembled.
 *
 * The cockpit had none of it. Sections were unlabelled divs, so each surface
 * invented its own spacing and the result read as a stack of unrelated pieces.
 *
 * THE MONO-UPPERCASE HEADER IS THE MACHINE'S VOICE, the same register as
 * `Marker` in the transcript. It names a region of the record; it is never a
 * sentence addressed to the reader. If the label wants a verb, it is a heading,
 * not a panel header.
 */

/** The state vocabulary from globals.css, and nothing else — five meanings,
 *  five tokens. A sixth ramp is how two surfaces start disagreeing about what
 *  amber means. `none` tints nothing, which is the common case. */
export type PanelTone = "none" | "active" | "attention" | "danger" | "done" | "info";

/**
 * The header bar.
 *
 * `count` renders even at 0 — a panel that says `DESK 0` is reporting an empty
 * desk, which is information. Pass `undefined` for a panel where a count would
 * be meaningless rather than zero.
 */
export function PanelHeader({
  icon,
  label,
  count,
  tone = "none",
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  icon?: ReactNode;
  label: string;
  count?: number;
  tone?: PanelTone;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase",
        className,
      )}
      {...props}
    >
      {icon && (
        <span
          className={cn(
            "flex shrink-0 [&_svg]:size-3.5",
            tone === "attention" && "text-warning",
            tone === "danger" && "text-destructive",
            tone === "done" && "text-success",
            tone === "active" && "text-primary",
            tone === "info" && "text-info",
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-0.5">{actions}</span>}
    </div>
  );
}

/**
 * A row inside a panel.
 *
 * NO COLOURED RAIL. A row that has a state says it as a short muted word at its
 * trailing edge, which every call site already does; a stripe beside that word
 * said the same thing twice, and on its own said it only to readers who had
 * learned the colours.
 */
export function PanelRow({ active, className, ...props }: ComponentProps<"div"> & { active?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2 px-3 py-2 pl-4 text-sm",
        active && "bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

/** Names what is missing rather than drawing a shape that implies a feature. */
export function PanelEmpty({
  icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "gap-1 px-3 py-6" : "gap-1.5 px-4 py-10")}>
      {icon && <span className="text-muted-foreground/60 [&_svg]:size-5">{icon}</span>}
      <p className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{title}</p>
      {children && <p className={cn("max-w-64 text-muted-foreground", compact ? "text-2xs" : "text-xs")}>{children}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

/**
 * A heading for a REGION INSIDE a panel — the same mono-uppercase voice as
 * `PanelHeader`, one level down and without the border.
 *
 * `count` is optional here, unlike the header's: a section that names a region
 * with nothing countable in it — a setting, a single control — would otherwise
 * have to invent a number to say nothing with.
 */
export function PanelSectionLabel({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 font-mono text-3xs tracking-[0.08em] text-muted-foreground uppercase">
      <span className="min-w-0 truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-muted-foreground/60 tabular-nums">{count}</span>}
    </div>
  );
}

/** A hairline divider carrying a mono label — the frozen app's `DONE · 1`. */
export function PanelDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="h-px flex-1 bg-border" />
      <span className="font-mono text-4xs tracking-[0.08em] text-muted-foreground uppercase">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
