"use client";

import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, GaugeIcon, ShieldIcon } from "lucide-react";
import type { ProviderDriverKind, RuntimeMode, UsageSnapshot } from "@telar/engine-client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE COMPOSER'S CONTROL ROW.
 *
 * One shape for every control — icon, label, optional detail, chevron — because
 * they are all the same kind of thing: a fact about the next message that you
 * can change by pressing it. Three separate visual treatments for "which agent",
 * "how much rope" and "how full is the context" is how a toolbar becomes a
 * junk drawer.
 *
 * A CONTROL THAT CANNOT CHANGE STILL SAYS WHY. The provider is fixed when the
 * session is created — the engine routes turns by `providerInstanceId` and its
 * `updateSession` patch accepts only title, runtime mode and detached (see
 * apps/engine/src/state.ts). The frozen app locks the same control the same way
 * once a session exists (`runtimeLocked={sessionId !== null || busy}`), so a
 * disabled pill here is FAITHFUL rather than a shortcut. What it must not do is
 * go quiet about it: the popover states the reason.
 */

const PROVIDER_LABEL: Record<ProviderDriverKind, string> = { claude: "Claude", codex: "Codex" };

function controlClass(open: boolean, disabled?: boolean) {
  return cn(
    "flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-xs font-medium text-muted-foreground transition-colors",
    !disabled && "hover:bg-accent hover:text-foreground",
    disabled && "opacity-70",
    open && "border-ring bg-accent text-foreground",
  );
}

type ControlTriggerProps = ComponentPropsWithoutRef<"button"> & {
  open: boolean;
  icon: ReactNode;
  label: string;
  detail?: string;
  ariaLabel: string;
};

export const ControlTrigger = forwardRef<HTMLButtonElement, ControlTriggerProps>(
  ({ open, icon, label, detail, ariaLabel, className, ...props }, ref) => (
    <button {...props} ref={ref} type="button" className={cn(controlClass(open, props.disabled), className)} aria-label={ariaLabel}>
      <span className="flex shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span className="max-w-32 truncate text-foreground">{label}</span>
      {detail ? (
        <>
          <span className="hidden text-muted-foreground/40 md:inline">·</span>
          <span className="hidden max-w-24 truncate md:inline">{detail}</span>
        </>
      ) : null}
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  ),
);
ControlTrigger.displayName = "ControlTrigger";

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1 pb-1 font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">{children}</div>;
}

/** A single-select row: label, optional description, tick when chosen. */
function ChoiceRow({
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
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        !disabled && "hover:bg-accent",
        disabled && "cursor-default opacity-60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {description && <span className="block text-[11px] leading-snug text-muted-foreground">{description}</span>}
      </span>
      {selected && <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />}
    </button>
  );
}

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask first",
  "auto-accept-edits": "Auto edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** What each mode actually permits, in the terms a human decides in. */
export const RUNTIME_MODE_HELP: Record<RuntimeMode, string> = {
  "approval-required": "Asks before running commands or changing files. Reads are allowed.",
  "auto-accept-edits": "Edits and reads files freely. Asks before running commands.",
  auto: "Runs tools without asking. Questions still reach you.",
  "full-access": "Never asks. Use when nobody is watching and the blast radius is bounded.",
};

const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** The agent: who answers, and on what model. */
export function AgentControl({ driver, model, effort }: { driver: ProviderDriverKind; model?: string; effort?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<span className="grid size-3.5 place-items-center rounded-[3px] bg-foreground/80 text-[8px] font-bold text-background">{driver === "codex" ? "C" : "A"}</span>}
            label={model ?? PROVIDER_LABEL[driver]}
            detail={effort}
            ariaLabel={`Agent: ${PROVIDER_LABEL[driver]}${model ? `, model ${model}` : ""}`}
            className="w-40 justify-start"
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
        <MenuHeading>agent</MenuHeading>
        <div className="rounded-xl bg-muted/35 p-1">
          <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="text-sm font-medium">{PROVIDER_LABEL[driver]}</span>
            {model && <span className="ml-auto font-mono text-xs text-muted-foreground">{model}</span>}
          </div>
          {effort && (
            <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
              <span className="text-sm text-muted-foreground">Effort</span>
              <span className="ml-auto font-mono text-xs">{effort}</span>
            </div>
          )}
        </div>
        {/* THE REASON, not just a disabled control. The engine routes a turn by
            the session's provider instance and its session patch accepts only
            title, runtime mode and detached — so this genuinely cannot change
            here, and saying so beats a greyed-out menu nobody can explain. */}
        <p className="px-2 pt-2 text-[11px] text-muted-foreground">
          Fixed when the session was created. Start a new session to work with a different agent.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** How much rope. A brake a human can reach MID-TURN, so it never locks. */
export function RuntimeModeControl({ mode, onChange, disabled }: { mode: RuntimeMode; onChange: (mode: RuntimeMode) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            disabled={disabled}
            icon={<ShieldIcon />}
            label={RUNTIME_MODE_LABELS[mode]}
            ariaLabel={`What this session may do without asking: ${RUNTIME_MODE_LABELS[mode]}`}
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))] gap-0 rounded-2xl p-2">
        <MenuHeading>what it may do without asking</MenuHeading>
        <div className="space-y-0.5">
          {RUNTIME_MODES.map((option) => (
            <ChoiceRow
              key={option}
              label={RUNTIME_MODE_LABELS[option]}
              description={RUNTIME_MODE_HELP[option]}
              selected={option === mode}
              onSelect={() => {
                onChange(option);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * How full the context is.
 *
 * ONLY RENDERED WHEN THE PROVIDER REPORTED IT. `UsageSnapshot` carries
 * `contextUsed`/`contextMax` and today only the Codex driver populates them
 * (apps/engine/src/codex/items.ts). A pill that showed "0%" for Claude would be
 * a measurement of nothing dressed as a reading, so it is absent instead — and
 * absent is legible, where a wrong number is not.
 */
export function ContextPill({ usage }: { usage?: UsageSnapshot }) {
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  if (used === undefined || max === undefined || max <= 0) return null;

  const pct = Math.min(100, Math.max(0, (used / max) * 100));
  // --warning above 80%: the point at which a person may want to act, which is
  // the one thing this token means anywhere in the app.
  const tight = pct >= 80;

  return (
    <span
      className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground", tight && "text-warning")}
      title={`${used.toLocaleString()} of ${max.toLocaleString()} context tokens used`}
    >
      <GaugeIcon className="size-3.5 shrink-0" />
      <span className="font-mono tabular-nums">
        {pct.toFixed(0)}% · {compactTokens(used)}/{compactTokens(max)}
      </span>
    </span>
  );
}

/** Shown while a turn is running and background work outlives it. */
export function BackgroundPresence({ count, onStop }: { count: number; onStop: () => void }) {
  if (count === 0) return null;
  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border bg-card/60 px-2.5 py-1.5">
      <span className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        {count} {count === 1 ? "task" : "tasks"} still working
      </span>
      <Button type="button" size="xs" variant="outline" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}
