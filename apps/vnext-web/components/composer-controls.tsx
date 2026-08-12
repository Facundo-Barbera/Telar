"use client";

import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, GaugeIcon, MoreHorizontalIcon, ShieldCheckIcon, StarIcon } from "lucide-react";
import type { ModelCatalogue, ProviderDriverKind, RuntimeMode, UsageSnapshot } from "@telar/engine-client";
import { fmtTokens } from "@/lib/format";
import {
  CONTEXT_WINDOWS,
  PROVIDER_EFFORTS,
  effortLabel,
  modelLabel,
  supportsLongContext,
  type ModelChoice,
} from "@/lib/models";
import { orderByFavorite, readFavorites, toggleFavorite, writeFavorites } from "@/lib/model-favorites";
import { defaultModelId, effortsFor, splitGenerations } from "@/lib/model-generations";
import { createVNextApi } from "@/lib/vnext/client";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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

/**
 * A PILL IS TEXT WITH A CHEVRON, NOT A BUTTON WITH A BORDER.
 *
 * These carried `border border-input` at `h-8`, which made three of them read as
 * three chips bolted to the bottom of the composer — a row of chrome competing
 * with the message box it belongs to. The reference cockpit draws the same three
 * as borderless labels separated by hairlines, and the difference is entirely
 * one of weight: the settings are ambient facts you glance at, not actions you
 * are being offered.
 *
 * The border comes back on HOVER and while OPEN, which is where a target needs
 * to announce itself and nowhere else.
 */
function controlClass(open: boolean, disabled?: boolean) {
  return cn(
    "flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-transparent px-2 text-xs font-medium text-muted-foreground transition-colors",
    !disabled && "hover:bg-accent hover:text-foreground",
    disabled && "opacity-70",
    open && "bg-accent text-foreground",
  );
}

/** The hairline between two pills. Ported from the reference row, where it is
 *  what lets borderless controls still read as separate things. */
export function ControlDivider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border" />;
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

/**
 * A COMPACT row: one line, a tick, nothing else.
 *
 * The two-line `ChoiceRow` below is right where the choice needs explaining —
 * the access modes, the model list — and wrong for a list of seven effort levels
 * everyone already understands, where it turned a short menu into a half-screen
 * panel. This is the reference cockpit's shape for exactly those lists.
 */
function CompactRow({
  label,
  hint,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  /** A word, not a sentence — "Default", "1M". Never wraps. */
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
      {hint && <span className="shrink-0 text-[10px] text-muted-foreground">{hint}</span>}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {selected && <CheckIcon className="size-3.5 text-primary" />}
      </span>
    </button>
  );
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

/**
 * The catalogue, fetched once per driver per page.
 *
 * MODULE SCOPE, NOT COMPONENT STATE. There are three controls that need it —
 * the model picker, the reasoning menu and the overflow — and the read is a
 * subprocess spawn on the engine's side. One promise per driver, shared, means
 * opening a popover never costs a second one.
 */
const catalogues = new Map<ProviderDriverKind, Promise<ModelCatalogue>>();
const api = createVNextApi();

function useModelCatalogue(driver: ProviderDriverKind): ModelCatalogue | undefined {
  const [catalogue, setCatalogue] = useState<ModelCatalogue>();
  useEffect(() => {
    let cancelled = false;
    // Deferred, like every other read in this app that the server could not
    // have performed.
    const task = window.setTimeout(() => {
      let pending = catalogues.get(driver);
      if (!pending) {
        pending = api.modelCatalogue(driver).then((result) => result.catalogue);
        catalogues.set(driver, pending);
        // A failed read must not poison the cache — the next popover should try
        // again rather than inherit the error for the life of the page.
        void pending.catch(() => catalogues.delete(driver));
      }
      void pending.then((result) => !cancelled && setCatalogue(result)).catch(() => undefined);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [driver]);
  return catalogue;
}

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
  choice,
  onChange,
  onDriverChange,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  /** Absent on a session that does not exist yet — the fresh canvas picks a
   *  model before there is anything to patch. */
  onChange?: (next: ModelChoice) => void;
  /** Absent once the session exists, which is what locks the rail. */
  onDriverChange?: (driver: ProviderDriverKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const catalogue = useModelCatalogue(driver);
  const readOnly = !onChange;
  const { effort } = choice;
  const models = catalogue?.models ?? [];
  const { current, legacy } = splitGenerations(models);
  /**
   * READ AFTER MOUNT, like every other localStorage-backed preference in this
   * app: the server has no storage to agree with, and a value picked during
   * render is a hydration mismatch waiting for its first star.
   */
  const [favorites, setStoredFavorites] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const task = window.setTimeout(() => setStoredFavorites(readFavorites()), 0);
    return () => window.clearTimeout(task);
  }, []);
  const setFavorites = (next: Set<string>) => {
    setStoredFavorites(next);
    writeFavorites(next);
  };
  /**
   * An absent model still SELECTS a row: the provider's own default is what
   * will run, and a menu with nothing ticked reads as broken rather than unset.
   * Nothing is written for it — sending no model IS asking for the default, and
   * the row simply says which one that is.
   */
  const selectedModel = choice.model ?? defaultModelId(models);
  const shown = orderByFavorite(showLegacy ? [...current, ...legacy] : current, favorites);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<ProviderIcon provider={driver} size={14} />}
            label={modelLabel(driver, choice.model)}
            {...(effort ? { detail: effortLabel(effort) } : {})}
            ariaLabel={`Model: ${modelLabel(driver, choice.model)} on ${PROVIDER_LABEL[driver]}`}
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
        className="max-h-[min(26rem,70vh)] w-64 flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        {/**
         * THE PROVIDER RAIL — the donor's own `w-14` column, minus its
         * favourites star, which is now a per-row toggle instead.
         *
         * The provider belongs HERE rather than in an overflow menu, and not
         * only to shorten the row: which provider you are on decides which
         * models exist, so the two questions are one question.
         */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 p-1.5">
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
                  "flex size-8 items-center justify-center rounded-lg transition-colors disabled:cursor-default",
                  option === driver
                    ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  option !== driver && !onDriverChange && "opacity-40",
                )}
              >
                <ProviderIcon provider={option} size={15} />
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1">
            {/**
             * ONE LINE PER MODEL, and no "Provider default" row.
             *
             * Each row used to carry a sentence of prose, which made a list of
             * four the tallest thing in the cockpit and buried the only word
             * anybody reads — the name. And the default is now a MODEL rather
             * than an option: "whatever the harness is configured with" asked
             * the reader to hold two ideas at once, when the answer to "which
             * model is running" is the only one they wanted.
             */}
            {shown.map((option) => {
              const starred = favorites.has(option.id);
              return (
                <div key={option.id} className="group/model flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      // A model that cannot take the long window drops the
                      // request rather than carrying it into a call the provider
                      // would refuse.
                      // A model that cannot take the long window drops the
                      // request rather than carrying it into a call the provider
                      // would refuse.
                      onChange?.({
                        ...choice,
                        model: option.id,
                        ...(supportsLongContext(driver, option.id) ? {} : { contextWindow: undefined }),
                        // An effort the new model does not support would fail
                        // the turn, so it goes with the model it belonged to.
                        ...(choice.effort && !option.efforts.includes(choice.effort) ? { effort: undefined } : {}),
                      });
                      setOpen(false);
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      option.id === selectedModel ? "bg-accent" : "hover:bg-accent/60",
                      readOnly && "cursor-default opacity-60",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.isDefault && <span className="shrink-0 text-[10px] text-muted-foreground">Default</span>}
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      {option.id === selectedModel && <CheckIcon className="size-3.5 text-primary" />}
                    </span>
                  </button>
                  {/* The star stays out of the row's own hit target: pressing a
                      model must never be one pixel away from favouriting it. */}
                  <button
                    type="button"
                    aria-label={starred ? `Unstar ${option.label}` : `Star ${option.label}`}
                    title={starred ? "Remove from favourites" : "Keep at the top"}
                    onClick={() => setFavorites(toggleFavorite(favorites, option.id))}
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
                      starred ? "opacity-100" : "opacity-0 group-hover/model:opacity-60 focus-visible:opacity-100",
                    )}
                  >
                    <StarIcon className={cn("size-3.5", starred && "fill-current text-primary")} />
                  </button>
                </div>
              );
            })}
            {/**
             * OLDER GENERATIONS, FOLDED. A provider's list grows and never
             * shrinks — Codex reports seven models and four of them are
             * previous families kept for people who pinned them. The rule is
             * "older than the provider's own default" rather than a list of ids
             * this repository would have to keep editing: see
             * lib/model-generations.ts.
             */}
            {legacy.length > 0 && !showLegacy && (
              <button
                type="button"
                onClick={() => setShowLegacy(true)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60"
              >
                <span className="min-w-0 flex-1 truncate">Legacy models</span>
                <span className="shrink-0 text-[10px]">{legacy.length}</span>
                <ChevronRightIcon className="size-3.5 shrink-0" />
              </button>
            )}
            {/* A model this catalogue does not list — set by another client, or
                added upstream since. Shown so the session never reads as running
                something it is not. */}
            {choice.model && models.length > 0 && !models.some((option) => option.id === choice.model) && (
              <CompactRow label={choice.model} hint="external" selected disabled onSelect={() => undefined} />
            )}
            {!catalogue && <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Asking {PROVIDER_LABEL[driver]}…</p>}
            {catalogue && models.length === 0 && (
              <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                {catalogue.message ?? `${PROVIDER_LABEL[driver]} did not report any models.`}
              </p>
            )}
          </div>
        </div>
        <p className="border-t border-border px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
          {readOnly
            ? "Chosen when the session starts."
            : onDriverChange
              ? "Applies to the first message. The provider is fixed after that."
              : `Next turn. Provider stays ${PROVIDER_LABEL[driver]}.`}
          {/* Whether this list was ASKED FOR or guessed. The distinction matters
              the moment an id here 404s at the provider. */}
          {catalogue?.source === "builtin" && models.length > 0 ? " List is this cockpit's own." : ""}
        </p>
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
  choice,
  onChange,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  onChange?: (next: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = effortLabel(choice.effort);
  const catalogue = useModelCatalogue(driver);
  /**
   * PER MODEL, not per provider. Codex reports six levels for its newest model
   * and four for an older one, and offering a level a model does not have fails
   * the whole turn. The static list is the fallback for a catalogue that has not
   * loaded or could not be read.
   */
  const reported = effortsFor(catalogue?.models ?? [], choice.model ?? defaultModelId(catalogue?.models ?? []));
  const levels = reported.length > 0 ? reported : PROVIDER_EFFORTS[driver];
  const readOnly = !onChange;
  /**
   * BOTH EXTRA GROUPS ARE CLAUDE-ONLY AND SAY SO BY BEING ABSENT.
   *
   * The 1M window is an Agent SDK `betas` flag and fast mode is an inline
   * `settings.fastMode`; the Codex app-server has neither, and its driver
   * ignores both (see apps/engine/src/codex-driver.ts). A switch that silently
   * did nothing on half the sessions is the thing this whole cockpit keeps
   * refusing to ship.
   */
  const claude = driver === "claude";
  const longContext = supportsLongContext(driver, choice.model);

  /** Every row re-sends the WHOLE choice. Picking an effort must not clear the
   *  model, and picking a window must not clear the effort. */
  const pick = (next: Partial<ModelChoice>) => {
    onChange?.({ ...choice, ...next });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<GaugeIcon className="size-3.5" />}
            label={label}
            {...(choice.contextWindow === "1m" ? { detail: "1M" } : {})}
            ariaLabel={`Reasoning effort: ${label}`}
          />
        }
      />
      <PopoverContent align="start" side="top" sideOffset={8} className="max-h-[min(26rem,70vh)] w-56 gap-0 overflow-y-auto rounded-xl p-1">
        <MenuHeading>Reasoning</MenuHeading>
        <CompactRow label="Auto" selected={!choice.effort} disabled={readOnly} onSelect={() => pick({ effort: undefined })} />
        {levels.map((level) => (
          <CompactRow
            key={level}
            label={effortLabel(level)}
            selected={choice.effort === level}
            disabled={readOnly}
            onSelect={() => pick({ effort: level })}
          />
        ))}
        {/* A level this list does not offer — another client's, or one this
            provider spells differently. `Effort` is an open string in the
            contract, so it is shown rather than silently replaced. */}
        {choice.effort && !levels.some((level) => level === choice.effort) && (
          <CompactRow label={choice.effort} hint="external" selected disabled onSelect={() => undefined} />
        )}

        {claude && longContext && (
          <div className="mt-1 border-t border-border pt-1">
            <MenuHeading>Context window</MenuHeading>
            {CONTEXT_WINDOWS.map((option) => (
              <CompactRow
                key={option.id}
                label={option.label}
                {...(option.id === "default" ? { hint: "200K" } : {})}
                selected={(choice.contextWindow ?? "default") === option.id}
                disabled={readOnly}
                // `default` is the ABSENCE of a choice, so it is cleared rather
                // than stored — the engine should never carry a field that says
                // "whatever you were going to do anyway".
                onSelect={() => pick({ contextWindow: option.id === "default" ? undefined : option.id })}
              />
            ))}
          </div>
        )}

        {claude && (
          <div className="mt-1 border-t border-border pt-1">
            <MenuHeading>Fast mode</MenuHeading>
            <CompactRow label="Off" selected={choice.fastMode !== true} disabled={readOnly} onSelect={() => pick({ fastMode: undefined })} />
            <CompactRow label="On" selected={choice.fastMode === true} disabled={readOnly} onSelect={() => pick({ fastMode: true })} />
          </div>
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
  choice,
  runtimeMode,
  fresh,
  envMode,
  onChange,
  onRuntimeMode,
  onDriverChange,
  onEnvMode,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  runtimeMode?: RuntimeMode;
  /** Before a session exists the provider and the workspace are still choices;
   *  after, neither is. */
  fresh?: boolean;
  envMode?: "local" | "worktree";
  onChange?: (next: ModelChoice) => void;
  onRuntimeMode?: (mode: RuntimeMode) => void;
  onDriverChange?: (driver: ProviderDriverKind) => void;
  onEnvMode?: (mode: "local" | "worktree") => void;
}) {
  const claude = driver === "claude";
  const longContext = supportsLongContext(driver, choice.model);
  const catalogue = useModelCatalogue(driver);
  // Same per-model rule as the pill's menu — see `ReasoningControl`.
  const reported = effortsFor(catalogue?.models ?? [], choice.model ?? defaultModelId(catalogue?.models ?? []));
  const levels = reported.length > 0 ? reported : PROVIDER_EFFORTS[driver];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More composer settings"
            title="Everything else about this message"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-[min(30rem,70vh)] w-60 overflow-y-auto">
        {/**
         * EVERY SETTING, NOT SOME OF THEM. This menu exists because the pills do
         * not fit, so anything the pills can do it must also do — otherwise a
         * narrow window silently takes features away, which is exactly what it
         * did: on a fresh canvas there is no session, so there was no runtime
         * mode, so the only group here was Reasoning.
         *
         * EVERY LABEL IS INSIDE A GROUP. Base UI's `Menu.GroupLabel` reads
         * `MenuGroupContext` and THROWS without a `Menu.Group` above it — a bare
         * label does not degrade, it takes the page down when the menu opens.
         */}
        {onChange && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onChange({ ...choice, effort: undefined })}>
              <span className="flex-1">Auto</span>
              {!choice.effort && <CheckIcon className="size-3.5 text-primary" />}
            </DropdownMenuItem>
            {levels.map((level) => (
              <DropdownMenuItem key={level} onClick={() => onChange({ ...choice, effort: level })}>
                <span className="flex-1">{effortLabel(level)}</span>
                {choice.effort === level && <CheckIcon className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}

        {onChange && claude && longContext && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Context window</DropdownMenuLabel>
              {CONTEXT_WINDOWS.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => onChange({ ...choice, contextWindow: option.id === "default" ? undefined : option.id })}
                >
                  <span className="flex-1">{option.label}</span>
                  {(choice.contextWindow ?? "default") === option.id && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {onChange && claude && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Fast mode</DropdownMenuLabel>
              {[
                { on: false, label: "Off" },
                { on: true, label: "On" },
              ].map((option) => (
                <DropdownMenuItem key={option.label} onClick={() => onChange({ ...choice, fastMode: option.on ? true : undefined })}>
                  <span className="flex-1">{option.label}</span>
                  {(choice.fastMode === true) === option.on && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {runtimeMode && onRuntimeMode && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Access</DropdownMenuLabel>
              {RUNTIME_MODES.map((option) => (
                <DropdownMenuItem key={option} onClick={() => onRuntimeMode(option)}>
                  <span className="flex-1">{RUNTIME_MODE_LABELS[option]}</span>
                  {option === runtimeMode && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {/* The two create-time choices. They live on other surfaces when there
            is room — the provider in the model picker's rail, the workspace in
            the composer's foot — and a narrow window must not be the reason you
            cannot reach them. */}
        {fresh && onDriverChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Provider</DropdownMenuLabel>
              {PROVIDERS.map((option) => (
                <DropdownMenuItem key={option} onClick={() => onDriverChange(option)}>
                  <ProviderIcon provider={option} size={14} />
                  <span className="flex-1">{PROVIDER_LABEL[option]}</span>
                  {option === driver && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}

        {fresh && onEnvMode && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              {(["local", "worktree"] as const).map((option) => (
                <DropdownMenuItem key={option} onClick={() => onEnvMode(option)}>
                  <span className="flex-1">{option === "worktree" ? "Own worktree" : "Project checkout"}</span>
                  {option === (envMode ?? "local") && <CheckIcon className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
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
