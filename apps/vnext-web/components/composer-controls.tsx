"use client";

import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, GaugeIcon, MoreHorizontalIcon, ShieldCheckIcon } from "lucide-react";
import type { ProviderDriverKind, RuntimeMode, UsageSnapshot } from "@telar/engine-client";
import { fmtTokens } from "@/lib/format";
import { EFFORT_HELP, EFFORT_LABEL, PROVIDER_EFFORTS, effortLabel, MODELS, modelLabel, type Effort } from "@/lib/models";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE COMPOSER'S CONTROL ROW, ported from the frozen app's
 * components/session/composer-settings.tsx.
 *
 * One shape for every control — icon, label, optional detail, chevron — because
 * they are all the same kind of thing: a fact about the next message that you
 * can change by pressing it.
 *
 * THREE PILLS, THE DONOR'S THREE: model, reasoning, access. They fold into a
 * `···` only when the composer is too narrow to hold them, never by default —
 * see `ComposerOverflowMenu`.
 *
 * A CONTROL THAT CANNOT CHANGE STILL SAYS WHY. The provider is fixed when the
 * session is created — the engine routes turns by `providerInstanceId`, which
 * owns the resume cursor. The donor locks the same control the same way once a
 * session exists (`runtimeLocked={sessionId !== null || busy}`), so a disabled
 * provider in the model popover's rail is FAITHFUL rather than a shortcut. What
 * it must not do is go quiet about it: the popover states the reason.
 *
 * NOTHING INSIDE THE COMPOSER'S OWN BOX MAY CARRY `disabled`. `InputGroup`
 * applies `has-disabled:opacity-50`, so ONE disabled descendant greys the entire
 * composer — box, pills, placeholder and all. Every trigger here therefore stays
 * live and explains itself inside its popover, which renders in a portal and is
 * free to disable whatever it likes.
 */

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
      {/* THE SECONDARY FACT APPEARS ONLY WHILE THE ROW IS FOLDED. The donor hid
          it below `md:` — a VIEWPORT query, which is the wrong instrument: this
          pill lives in a column that the right panel narrows while the window
          stays wide, so `md:` reports on something else entirely. Gated on the
          composer's own container instead, and inverted: the effort rides on the
          model pill exactly when the reasoning pill has folded into `···`, so
          the level is never invisible. */}
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

function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

/** A single-select row: label, description, tick when chosen. */
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

/** The donor's vocabulary, verbatim (lib/runtime-mode-client.ts). */
export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HELP: Record<RuntimeMode, string> = {
  "approval-required": "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "A reviewer approves routine actions; risky ones still ask.",
  "full-access": "Allow commands and edits without prompts.",
};

const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** Every provider the engine can drive. Two, and the contract's union is the
 *  reason this is not a lookup — a third would want a rail entry, not a row. */
const PROVIDERS: ProviderDriverKind[] = ["claude", "codex"];

/**
 * THE MODEL PICKER — not just a readout of which agent answers.
 *
 * The PROVIDER is fixed for the session's life and the MODEL is not, and that
 * asymmetry is the engine's, not a UI simplification: a turn is routed by
 * `providerInstanceId` and the provider owns the resume cursor that makes the
 * conversation continuous, so swapping providers mid-session would strand the
 * history. Swapping models inside the session's own provider costs nothing —
 * the next claimed turn just runs on the new one (apps/engine/src/state.ts,
 * `updateSession`, and the model now carried on `WorkerClaim`).
 *
 * IT TAKES EFFECT ON THE NEXT TURN, never the running one. The engine resolves
 * the model at CLAIM time, so a change made mid-turn cannot retroactively alter
 * work already in flight — which is why this control stays live while busy
 * instead of locking.
 */
export function AgentControl({
  driver,
  model,
  effort,
  onModelChange,
  onDriverChange,
}: {
  driver: ProviderDriverKind;
  model?: string;
  effort?: string;
  /** Absent on a session that does not exist yet — the fresh canvas picks a
   *  model before there is anything to patch. */
  onModelChange?: (next: { model?: string; effort?: Effort }) => void;
  /** Absent once the session exists, which is what locks the rail. */
  onDriverChange?: (driver: ProviderDriverKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = MODELS[driver];
  const readOnly = !onModelChange;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<ProviderIcon provider={driver} size={14} />}
            label={modelLabel(driver, model)}
            {...(effort ? { detail: effortLabel(effort) } : {})}
            ariaLabel={`Model: ${modelLabel(driver, model)} on ${PROVIDER_LABEL[driver]}`}
            // Shrinks rather than forcing the row to overflow: the composer
            // shares the window with the right panel and cannot assume width.
            className="min-w-0 max-w-44 justify-start"
          />
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-[min(23rem,calc(100vw-2rem))] flex-row gap-0 overflow-hidden rounded-2xl p-0"
      >
        {/**
         * THE PROVIDER RAIL — the donor's own `w-14` column, minus its
         * favourites star (nothing here stores favourites yet).
         *
         * The provider belongs HERE rather than in an overflow menu, and not
         * only to shorten the row: which provider you are on decides which
         * models exist, so the two questions are one question. Answering them in
         * different places is what made the `···` permanent.
         */}
        <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 p-2">
          {PROVIDERS.map((option) => (
            <button
              key={option}
              type="button"
              // Safe here and nowhere else in the composer: this content is
              // portalled, so it is outside `InputGroup`'s `has-disabled` reach.
              disabled={!onDriverChange}
              onClick={() => onDriverChange?.(option)}
              aria-label={PROVIDER_LABEL[option]}
              title={onDriverChange ? PROVIDER_LABEL[option] : `${PROVIDER_LABEL[option]} — fixed once the session exists`}
              className={cn(
                "flex size-9 items-center justify-center rounded-lg transition-colors disabled:cursor-default",
                option === driver
                  ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                option !== driver && !onDriverChange && "opacity-40",
              )}
            >
              <ProviderIcon provider={option} size={16} />
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-1.5">
          <MenuHeading>{PROVIDER_LABEL[driver]} models</MenuHeading>
          <ChoiceRow
            label="Provider default"
            description="Whatever the installed harness is configured to use."
            selected={!model}
            disabled={readOnly}
            onSelect={() => {
              // The EFFORT SURVIVES dropping back to the default model — they
              // are independent choices, and clearing one because the other
              // changed is the coupling this pair just stopped having.
              onModelChange?.(effort ? { effort: effort as Effort } : {});
              setOpen(false);
            }}
          />
          {options.map((option) => (
            <ChoiceRow
              key={option.id}
              label={option.label}
              description={option.blurb}
              selected={option.id === model}
              disabled={readOnly}
              onSelect={() => {
                onModelChange?.({ model: option.id, ...(effort ? { effort: effort as Effort } : {}) });
                setOpen(false);
              }}
            />
          ))}
          {/* A model this catalogue does not list — set by another client, or
              added upstream since. Shown so the session never reads as running
              something it is not. */}
          {model && !options.some((option) => option.id === model) && (
            <ChoiceRow label={model} description="Set outside this cockpit. Kept as-is." selected disabled onSelect={() => undefined} />
          )}
          <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">
            {readOnly
              ? "Chosen when the session starts."
              : onDriverChange
                ? "Applies to the first message. The provider is fixed after that."
                : `Applies to the next turn. The provider stays ${PROVIDER_LABEL[driver]} — start a new session to change it.`}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * HOW HARD TO THINK — the donor's reasoning pill, on the vocabulary the engine
 * can actually carry.
 *
 * The donor drove a per-turn option matrix the vNext contract does not have, so
 * this is the honest subset: `ModelSelection.effort`, which the engine stores on
 * the session and hands to the driver at claim time. Both drivers read it —
 * Codex forwards it to the app-server, Claude passes it to the Agent SDK's
 * `effort` — so the pill is a control rather than a label.
 *
 * IT NO LONGER NEEDS A MODEL, and that was a real defect rather than a
 * limitation. `ModelSelection` used to require a model in order to carry an
 * effort, so a session on the provider default — which is the DEFAULT — could
 * not be told to think harder: this popover said "pick a model first" and the
 * feature read as missing. Both providers take the two independently, so the
 * contract now does too.
 */
export function ReasoningControl({
  driver,
  model,
  effort,
  onModelChange,
}: {
  driver: ProviderDriverKind;
  model?: string;
  effort?: string;
  onModelChange?: (next: { model?: string; effort?: Effort }) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = effortLabel(effort);
  const levels = PROVIDER_EFFORTS[driver];
  const readOnly = !onModelChange;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger open={open} icon={<GaugeIcon className="size-3.5" />} label={label} ariaLabel={`Reasoning effort: ${label}`} />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-2xl p-1.5">
        <MenuHeading>Reasoning</MenuHeading>
        {/* THE MODEL RIDES ALONG UNCHANGED. Every row re-sends whatever model is
            currently selected — including none — so choosing an effort never
            silently clears the model, and choosing one on the provider default
            stays on the provider default. */}
        <ChoiceRow
          label="Auto"
          description={`Whatever ${PROVIDER_LABEL[driver]} does by default.`}
          selected={!effort}
          disabled={readOnly}
          onSelect={() => {
            onModelChange?.(model ? { model } : {});
            setOpen(false);
          }}
        />
        {levels.map((level) => (
          <ChoiceRow
            key={level}
            label={EFFORT_LABEL[level]}
            description={EFFORT_HELP[level]}
            selected={effort === level}
            disabled={readOnly}
            onSelect={() => {
              onModelChange?.({ ...(model ? { model } : {}), effort: level });
              setOpen(false);
            }}
          />
        ))}
        {/* A level this list does not offer — another client's, or one this
            provider spells differently. `Effort` is an open string in the
            contract, so it is shown rather than silently replaced. */}
        {effort && !levels.some((level) => level === effort) && (
          <ChoiceRow label={effort} description="Set outside this cockpit. Kept as-is." selected disabled onSelect={() => undefined} />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** How much rope this session has — the donor's approval pill, on the engine's
 *  four runtime modes. */
export function AccessControl({ runtimeMode, onRuntimeMode }: { runtimeMode: RuntimeMode; onRuntimeMode: (mode: RuntimeMode) => void }) {
  const [open, setOpen] = useState(false);
  const label = RUNTIME_MODE_LABELS[runtimeMode];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger open={open} icon={<ShieldCheckIcon className="size-3.5" />} label={label} ariaLabel={`Access: ${label}`} />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="w-[min(20rem,calc(100vw-2rem))] gap-0 rounded-2xl p-1.5">
        <MenuHeading>Access</MenuHeading>
        {RUNTIME_MODES.map((option) => (
          <ChoiceRow
            key={option}
            label={RUNTIME_MODE_LABELS[option]}
            description={RUNTIME_MODE_HELP[option]}
            selected={option === runtimeMode}
            onSelect={() => {
              onRuntimeMode(option);
              setOpen(false);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * THE SAME CONTROLS, FOR A COMPOSER TOO NARROW TO SHOW THEM.
 *
 * A `···` IS A LAST RESORT, NOT A LAYOUT. It hides state: a menu can say what
 * the reasoning level is only once you open it, so a composer that always folds
 * makes you click to learn what the next turn will do. This renders alongside
 * the pills and the two swap on the composer's own container width — see the
 * control row in composer.tsx. At any normal width you get the pills; the menu
 * appears only when the right panel has taken enough of the window that the row
 * would otherwise wrap or truncate into nonsense.
 *
 * The PROVIDER is deliberately not here. It moved into the model popover's rail,
 * where it belongs — it decides which models exist — and that is what stopped
 * this menu from being permanent.
 */
export function ComposerOverflowMenu({
  driver,
  model,
  effort,
  runtimeMode,
  onModelChange,
  onRuntimeMode,
}: {
  driver: ProviderDriverKind;
  model?: string;
  effort?: string;
  runtimeMode?: RuntimeMode;
  onModelChange?: (next: { model?: string; effort?: Effort }) => void;
  onRuntimeMode?: (mode: RuntimeMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More composer settings"
            title="Reasoning and access"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        {onModelChange && (
          <>
            <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
            {/* Independent of the model, as the providers are — see
                `ReasoningControl`. Each row re-sends the current model so
                picking an effort never clears it. */}
            <DropdownMenuItem onClick={() => onModelChange(model ? { model } : {})}>
              <span className="flex-1">Auto</span>
              {!effort && <CheckIcon className="size-3.5 text-primary" />}
            </DropdownMenuItem>
            {PROVIDER_EFFORTS[driver].map((level) => (
              <DropdownMenuItem key={level} onClick={() => onModelChange({ ...(model ? { model } : {}), effort: level })}>
                <span className="flex-1">{EFFORT_LABEL[level]}</span>
                {effort === level && <CheckIcon className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {runtimeMode && onRuntimeMode && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Access</DropdownMenuLabel>
            {RUNTIME_MODES.map((option) => (
              <DropdownMenuItem key={option} onClick={() => onRuntimeMode(option)}>
                <span className="flex-1">{RUNTIME_MODE_LABELS[option]}</span>
                {option === runtimeMode && <CheckIcon className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function compactTokens(value: number): string {
  return fmtTokens(value).replace(/\.0(?=[kM]$)/, "");
}

const RING_RADIUS = 11;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * How full the context is — the donor's 32px donut and its popover card.
 *
 * IT RENDERS EVEN WHEN THE FIGURE IS UNKNOWN, showing an em dash. `UsageSnapshot`
 * carries `contextUsed`/`contextMax` and today only the Codex driver populates
 * them (apps/engine/src/codex/items.ts), so on a Claude session this reads `—`
 * for the whole conversation. That is the donor's own behaviour after a
 * compaction it could not measure, and it is the honest shape: a gauge that
 * disappears makes the row jump, and one that prints `0%` measures nothing while
 * looking like a reading.
 */
export function ContextPill({ usage, driver }: { usage?: UsageSnapshot; driver?: ProviderDriverKind }) {
  const [open, setOpen] = useState(false);
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  const unknown = used === undefined;
  const usedPct = used === undefined || max === undefined || max <= 0 ? null : Math.min(100, Math.max(0, (used / max) * 100));

  const readout = unknown
    ? max
      ? `— / ${compactTokens(max)}`
      : "—"
    : usedPct === null
      ? compactTokens(used)
      : `${usedPct.toFixed(1)}% · ${compactTokens(used)}/${compactTokens(max!)}`;
  const harness = driver ? PROVIDER_LABEL[driver] : "The harness";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="relative flex size-8 items-center justify-center rounded-full text-[9px] font-medium tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={`Context window${unknown ? ", size not reported by this provider" : usedPct === null ? "" : ` ${usedPct.toFixed(1)}% used`}`}
            title="View context window"
          />
        }
      >
        <svg className="absolute inset-0 size-8 -rotate-90" viewBox="0 0 32 32" aria-hidden>
          <circle cx="16" cy="16" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="2.5" className="text-border" />
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - (usedPct ?? 0) / 100)}
            className="text-primary"
          />
        </svg>
        <span>{unknown ? "—" : usedPct === null ? compactTokens(used) : `${Math.round(usedPct)}%`}</span>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-auto gap-0 bg-transparent p-0 shadow-none ring-0">
        <div className="w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-lg">
          <div className="flex items-center justify-between gap-4">
            <span className="whitespace-nowrap text-sm font-medium">Context Window</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{readout}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-muted-foreground/70 transition-[width] duration-300" style={{ width: `${usedPct ?? 0}%` }} />
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total processed</span>
            <span className="font-mono font-medium">{unknown ? "—" : compactTokens(used)}</span>
          </div>
          {unknown && (
            <p className="mt-3 max-w-56 text-sm leading-snug text-muted-foreground">
              {harness} does not report context size to the engine yet, so there is nothing to measure here.
            </p>
          )}
          <p className="mt-5 max-w-56 text-sm leading-snug text-muted-foreground">{harness} automatically compacts its context when needed.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Shown while background work outlives the turn that started it. */
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
