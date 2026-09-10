"use client";

import { forwardRef, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, GaugeIcon, Minimize2Icon, MoreHorizontalIcon, SearchIcon, ShieldCheckIcon, StarIcon } from "lucide-react";
import type { ModelCatalogue, ProviderDriverKind, ProviderModel, RuntimeMode, UsageSnapshot } from "@telar/engine-client";
import { fmtTokens } from "@/lib/format";
import { effortLabel, modelLabel, type ModelChoice } from "@/lib/models";
import { keepStarredVisible, orderByFavorite } from "@/lib/model-favorites";
import { defaultModelId, splitGenerations } from "@/lib/model-generations";
import {
  contextWindowOf,
  familyOf,
  groupFamilies,
  pickInFamily,
  rowFor,
  rowOf,
  stripWindow,
  windowSuffix,
  windowsOf,
  visibleModels,
  familyFavorites,
  toggleFamilyFavorite,
  WINDOW_LABEL,
  type ContextWindow,
  type ModelFamily,
} from "@/lib/model-families";
import { importLocalFavorites, patchModelOverlay, useModelCatalogue, useModelCatalogues, useModelOverlays } from "@/lib/model-catalogue-cache";
import { connectionLabel, familySearchText, routeOf, routedModelLabel } from "@/lib/model-connections";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { ModelRowIcon } from "@/components/session/connection-icon";
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
      {/* max-w-48, was max-w-32: versioned model names ("Haiku 4.5") are the
          longest labels a pill carries, and 128px truncated them immediately.
          The other pills' labels are single words and never reach the cap. */}
      <span className="max-w-48 truncate text-foreground">{label}</span>
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
  return <div className="px-2 pb-1 pt-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
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
      {hint && <span className="shrink-0 text-[0.625rem] text-muted-foreground">{hint}</span>}
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
  "approval-required": "Asks before every action",
  "auto-accept-edits": "Other actions still ask",
  auto: "A reviewer waves routine actions through",
  "full-access": "No prompts",
};

const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/**
 * THE CATALOGUE HOOKS NOW LIVE IN `lib/model-catalogue-cache.ts`.
 *
 * They moved because the cache had to become forgettable and keyed by LOGIN
 * rather than by driver: a curated list is edited in the settings route, and a
 * page-lifetime promise map keyed by driver would both go on serving the
 * pre-edit list and serve one login's hidden rows to another. Nothing about how
 * these controls use them changed.
 */

/**
 * EVERYTHING THE THREE MENUS NEED TO KNOW ABOUT THE MODEL THAT WILL RUN.
 *
 * The pill, the reasoning popover and the overflow menu each used to work this
 * out for themselves, and the copies drifted — the overflow offered effort
 * levels the popover did not. One function, three callers, and the answers agree
 * by construction.
 */
function selectionOf(models: readonly ProviderModel[], choice: ModelChoice) {
  const families = groupFamilies(models);
  /**
   * An absent model still SELECTS a row: the provider's own default is what will
   * run, and a menu with nothing ticked reads as broken rather than unset.
   * Nothing is written for it — sending no model IS asking for the default, and
   * the row simply says which one that is.
   */
  const id = choice.model ?? defaultModelId(models);
  const row = rowOf(models, id);
  const family = familyOf(families, id);
  return {
    families,
    id,
    row,
    family,
    /** The window the next turn will actually run in. Unknown models read as
     *  standard, which is what an id without `[1m]` means. */
    window: (row ? contextWindowOf(row) : "standard") as ContextWindow,
    /** The windows this model comes in. One entry means nothing to choose. */
    windows: windowsOf(family),
    levels: row?.efforts ?? [],
    fastMode: row?.fastMode === true,
  };
}

/**
 * Move the choice to a different row, DROPPING WHAT THAT ROW CANNOT HONOUR.
 *
 * An effort a model does not list fails the turn outright; a fast-mode switch it
 * does not offer silently does nothing. Both are dropped here rather than
 * carried into a call the provider would refuse or ignore — and this is the one
 * place that decides it, so picking a model, a window or a favourite all behave
 * the same way.
 */
function withModel(choice: ModelChoice, row: ProviderModel): ModelChoice {
  /**
   * EXCEPT ON A ROW NOBODY PUBLISHED. A hand-added model has no published
   * `efforts` to check against — the engine fills them with the union of what
   * the driver offers precisely so this check has something true to read, but
   * the union is a guess about ONE model and the reader's own level is not.
   * Dropping it here would silently undo the setting on the row somebody typed
   * an id into in order to push a new model hard.
   */
  const trusted = row.source !== "user";
  return {
    ...choice,
    model: row.id,
    ...(trusted && choice.effort && !row.efforts.includes(choice.effort) ? { effort: undefined } : {}),
    ...(trusted && choice.fastMode && !row.fastMode ? { fastMode: undefined } : {}),
  };
}

/**
 * THE MODEL AND EFFORT ROWS THE `/` MENU OFFERS.
 *
 * Exported so the slash menu and the pills cannot disagree about what is on
 * offer: both go through `selectionOf`, so a model hidden from the picker is
 * hidden from the command list, and the effort levels are the SELECTED model's
 * rather than a union across the catalogue — offering `xhigh` on a model that
 * does not publish it fails the turn at the provider.
 *
 * LEGACY GENERATIONS ARE LEFT OUT. The picker keeps them behind a fold for
 * people who pinned one; a typed command is a shortcut, and a shortcut list is
 * only useful while it is short.
 */
export function useComposerCommandChoices(
  driver: ProviderDriverKind,
  choice: ModelChoice,
  instanceId?: string,
): { models: { id: string; label: string }[]; efforts: string[] } {
  const catalogue = useModelCatalogue(driver, instanceId);
  const models = catalogue?.models;
  // DESTRUCTURED, THEN REBUILT INSIDE. The composer makes a fresh `ModelChoice`
  // every render, so depending on its identity would refold the catalogue on
  // every keystroke; depending on the three fields it actually reads is the
  // same answer, computed when the answer can have changed.
  const { model, effort, fastMode } = choice;
  return useMemo(() => {
    if (!models) return { models: [], efforts: [] };
    const selection = selectionOf(models, {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(fastMode === undefined ? {} : { fastMode }),
    });
    return {
      // FOLDED FROM THE VISIBLE ROWS, not from `selection.families`: this
      // function's own contract is that the slash menu and the pills cannot
      // disagree about what is on offer, so a model the reader curated away has
      // to leave both. `selectionOf` above still reads the FULL list, because
      // the effort levels of a hidden-but-running model are still needed.
      models: splitGenerations(groupFamilies(visibleModels(models, model))).current.map((family) => ({
        id: pickInFamily(family, selection.window).id,
        label: stripWindow(family.label),
      })),
      efforts: [...selection.levels],
    };
  }, [models, model, effort, fastMode]);
}

/** Every provider with an engine adapter. OpenCode remains disabled until enabled in Settings. */
const PROVIDERS: ProviderDriverKind[] = ["claude", "codex", "opencode"];

/** What the rail selects: one provider's models, or the ones you starred. */
type ModelView = ProviderDriverKind | "favorites";

/** The scrollable list, addressed by the search field's arrow-down handoff. */
const MODEL_LIST_ID = "telar-model-picker-list";

/**
 * ONE LINE PER MODEL — the mark of who serves it, the name, which CONNECTION
 * routes it, whether it is the default, a tick, and a star.
 *
 * The row lists a FAMILY rather than a catalogue row (lib/model-families.ts):
 * `sonnet` and `sonnet[1m]` are one model here, and which window it runs in is a
 * setting on the reasoning pill.
 *
 * THE CONNECTION IS PART OF THE ANSWER, not decoration. OpenCode reaches one
 * model through several connections — `openai/gpt-5.6-luna` and
 * `opencode-go/gpt-5.6-luna` are two routes to one model, billed and
 * rate-limited differently — so a row that said only "GPT-5.6 Luna" twice
 * would be the same name with two different meanings. The badge names the
 * connection (models.dev's own names, lib/model-connections.ts), the icon is
 * its mark, and the title still carries the exact routing id that goes on the
 * wire. Claude Code and Codex rows carry their serving provider's mark the
 * same way, so all three lists read alike.
 *
 * THE HARNESS ICON IS ONLY ON A MIXED LIST. In the favourites view, which
 * spans providers, the leading mark is the HARNESS (Claude/Codex/OpenCode) —
 * the only thing saying where a starred model runs.
 */
function FamilyRow({
  family,
  driver,
  provider,
  selected,
  starred,
  readOnly,
  onSelect,
  onStar,
}: {
  family: ModelFamily;
  /** The harness whose catalogue this row came from. */
  driver: ProviderDriverKind;
  /** Set on a mixed (favourites) list: show the harness mark instead. */
  provider?: ProviderDriverKind;
  selected: boolean;
  starred: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  const route = routeOf(family.id);
  const label = route ? routedModelLabel(route.model) : family.label;
  return (
    <div className="group/model flex items-center gap-0.5">
      <button
        type="button"
        data-model-row
        disabled={readOnly}
        onClick={onSelect}
        // The exact id(s) this row can put on the wire — the routing id is a
        // fact worth hovering for, especially when two rows share a name.
        title={family.rows.map((row) => row.id).join("\n")}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/60",
          readOnly && "cursor-default opacity-60",
        )}
      >
        <span className="shrink-0 text-muted-foreground">
          {provider ? <ProviderIcon provider={provider} size={15} /> : <ModelRowIcon driver={driver} modelId={family.id} size={15} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {route && (
          <span className="max-w-24 shrink-0 truncate rounded border border-border/60 px-1 py-px text-[0.625rem] leading-4 text-muted-foreground">
            {connectionLabel(route.connection)}
          </span>
        )}
        {family.isDefault && <span className="shrink-0 text-[0.625rem] text-muted-foreground">Default</span>}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {selected && <CheckIcon className="size-3.5 text-primary" />}
        </span>
      </button>
      {/* The star stays out of the row's own hit target: pressing a model must
          never be one pixel away from favouriting it. */}
      <button
        type="button"
        aria-label={starred ? `Unstar ${label}` : `Star ${label}`}
        title={starred ? "Unstar" : "Star"}
        onClick={onStar}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
          starred ? "opacity-100" : "opacity-0 group-hover/model:opacity-60 focus-visible:opacity-100",
        )}
      >
        <StarIcon className={cn("size-3.5", starred && "fill-current text-primary")} />
      </button>
    </div>
  );
}

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
  instanceId,
  onChange,
  onDriverChange,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  /** Whose login's curated list to show. Absent means the driver's built-in
   *  slot, which is what the engine falls back to as well. */
  instanceId?: string;
  /** Absent on a session that does not exist yet — the fresh canvas picks a
   *  model before there is anything to patch. */
  onChange?: (next: ModelChoice) => void;
  /** Absent once the session exists, which is what locks the rail. */
  onDriverChange?: (driver: ProviderDriverKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  /**
   * THE SEARCH. OpenCode's multi-connection catalogue is two hundred rows on
   * this machine — a list nobody scrolls. Matching covers the display name,
   * the raw routing id, and the CONNECTION's name (lib/model-connections.ts),
   * so "go" narrows to OpenCode Go and "openai" to the direct connection.
   * While a query is live it searches past the Legacy fold too: a model you
   * can name is a model you were looking for.
   */
  const [query, setQuery] = useState("");
  /** Which rail entry is showing. Reset when the popover closes: reopening
   *  should land on the models you can run, not wherever you last wandered. */
  const [view, setView] = useState<ModelView>(driver);
  const readOnly = !onChange;
  const { effort } = choice;
  /**
   * FAVOURITES SPAN PROVIDERS — a star is a fact about a model, not about this
   * session — but only where a foreign model is something you could actually
   * run. Once the session exists its provider is fixed, so the other catalogue
   * would be a subprocess spawned to list models this session cannot use.
   */
  const crossProvider = view === "favorites" && Boolean(onDriverChange);
  // The session's own login for its own driver; the built-in slot for the other
  // one, which is the only login a not-yet-created session could mean.
  const catalogues = useModelCatalogues(
    crossProvider ? PROVIDERS.map((option) => (option === driver && instanceId ? { driver: option, instanceId } : { driver: option })) : [{ driver, ...(instanceId ? { instanceId } : {}) }],
  );
  const catalogue = catalogues.get(driver);
  const models = catalogue?.models ?? [];
  // `families` is deliberately NOT taken from here any more — see
  // `listedFamilies` below. What this call is still for is the SELECTION: which
  // family is ticked and which window it runs in, both of which must resolve for
  // a model the reader has since hidden.
  const { family: selectedFamily, window: activeWindow } = selectionOf(models, choice);
  /**
   * STARS COME FROM THE ENGINE NOW, not from this browser's `localStorage`.
   *
   * They moved because the Models tab in Settings stars the same models, against
   * the same login, and two stores behind one row is how "I unstarred it and it
   * came back" happens. The store is ROW-keyed and this menu is FAMILY-keyed, so
   * the set below is derived — see `familyFavorites`.
   */
  const overlays = useModelOverlays(
    crossProvider
      ? PROVIDERS.map((option) => (option === driver && instanceId ? { driver: option, instanceId } : { driver: option }))
      : [{ driver, ...(instanceId ? { instanceId } : {}) }],
  );
  const starredRows = overlays.get(driver)?.favorites ?? [];
  /** Every provider's stars at once, because the favourites view spans them. */
  const favorites = useMemo(() => {
    const out = new Set<string>();
    for (const option of crossProvider ? PROVIDERS : [driver]) {
      const rows = new Set(overlays.get(option)?.favorites ?? []);
      for (const id of familyFavorites(catalogues.get(option)?.models ?? [], rows)) out.add(id);
    }
    return out;
  }, [overlays, catalogues, crossProvider, driver]);

  /**
   * The stars somebody had before this moved, carried across once per login.
   * Best effort and silent — losing them is the gesture the `:v2` key bump
   * already established as survivable; losing the menu would not be.
   */
  const overlayLoaded = overlays.get(driver) !== undefined;
  useEffect(() => {
    if (!overlayLoaded || models.length === 0) return;
    const task = window.setTimeout(() => {
      void importLocalFavorites(instanceId ?? driver, models, starredRows);
    }, 0);
    return () => window.clearTimeout(task);
    // `starredRows` is read, not depended on: the import is guarded by its own
    // per-login sentinel, and depending on the list would re-run it on the very
    // write it performs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayLoaded, models.length, instanceId, driver]);

  /** Star a whole family — every row in it, so the derived bit above can never
   *  be half true. The write is optimistic in the sense that the cache is
   *  forgotten on success and every mounted menu re-reads. */
  const starFamily = (from: ProviderDriverKind, familyId: string) => {
    const rows = catalogues.get(from)?.models ?? [];
    const owner = from === driver ? (instanceId ?? driver) : from;
    const next = toggleFamilyFavorite(rows, overlays.get(from)?.favorites ?? [], familyId);
    void patchModelOverlay(owner, { favorites: next }).catch(() => undefined);
  };

  /**
   * THE MENU'S OWN LIST, which is not the same set as `families` above.
   *
   * `selectionOf` reads the FULL catalogue on purpose — the pill has to resolve
   * the effort levels, window and fast-mode flag of whatever is running, and a
   * model the reader curated away can still be the model running. Only the
   * LISTING drops hidden rows, and it keeps the running one (`visibleModels`),
   * so hiding never rewrites a session out from under anybody.
   */
  const listedFamilies = groupFamilies(visibleModels(models, choice.model));
  const { current, legacy } = keepStarredVisible(splitGenerations(listedFamilies), favorites);
  /**
   * THE LIST, EITHER WAY ROUND. A provider's own models are its current
   * generation, favourites first; the favourites view is every starred model on
   * every provider you could switch to, in catalogue order per provider.
   */
  const searching = query.trim().length > 0;
  const matches = (family: ModelFamily) => familySearchText(family).includes(query.trim().toLowerCase());
  const listed: { from: ProviderDriverKind; family: ModelFamily }[] = (
    view === "favorites"
      ? (crossProvider ? PROVIDERS : [driver]).flatMap((option) =>
          groupFamilies(visibleModels(catalogues.get(option)?.models ?? [], choice.model))
            .filter((family) => favorites.has(family.id))
            .map((family) => ({ from: option, family })),
        )
      : orderByFavorite(searching || showLegacy ? [...current, ...legacy] : current, favorites).map((family) => ({ from: driver, family }))
  ).filter((entry) => !searching || matches(entry.family));
  /** A provider the favourites view is still waiting on. Named, because a
   *  silently short list looks like a lost star. */
  const asking = (crossProvider ? PROVIDERS : [driver]).find((option) => !catalogues.get(option));

  /**
   * CLOSING RESETS THE VIEW, and every path that closes has to do it.
   *
   * Reopening should land on the models you can run rather than wherever you
   * last wandered, and the difference was visible: picking a starred model left
   * the view on Favourites, so the next open showed one row and no sign of the
   * provider's own list until you pressed the rail. Base UI routes its own
   * dismissals — escape, a press outside — through `onOpenChange`; a pick has to
   * say so itself.
   */
  const close = (onto: ModelView) => {
    setOpen(false);
    setView(onto);
    setShowLegacy(false);
    setQuery("");
  };

  /**
   * Pick a model. THE WINDOW YOU ARE ON COMES WITH YOU where the new model has
   * one — see `pickInFamily`.
   *
   * A CROSS-PROVIDER PICK SENDS THE MODEL AND NOTHING ELSE. Effort levels and
   * fast mode are the old provider's vocabulary and mean nothing to the new one,
   * so they go with the provider rather than into a turn that would refuse them.
   * It closes onto `from` for the same reason: after the switch, that is the
   * provider you are on, whatever this render still calls `driver`.
   */
  const pickFamily = (family: ModelFamily, from: ProviderDriverKind) => {
    const row = pickInFamily(family, activeWindow);
    if (from === driver) onChange?.(withModel(choice, row));
    else {
      onDriverChange?.(from);
      onChange?.({ model: row.id });
    }
    close(from);
  };

  /** The pill reads the routed name, not the raw route: `openai/gpt-5.6-luna`
   *  is "GPT-5.6 Luna · OpenAI" — the same two facts the row showed when it
   *  was picked, and the wire id is unchanged underneath. */
  const pillRoute = routeOf(selectedFamily?.id ?? choice.model ?? "");
  const label = pillRoute
    ? `${routedModelLabel(pillRoute.model)} · ${connectionLabel(pillRoute.connection)}`
    : (selectedFamily?.label ?? modelLabel(models, choice.model));

  return (
    <Popover open={open} onOpenChange={(next: boolean) => (next ? setOpen(true) : close(driver))}>
      <PopoverTrigger
        render={
          <ControlTrigger
            open={open}
            icon={<ProviderIcon provider={driver} size={14} />}
            /**
             * THE NAME, WITHOUT THE WINDOW. This read "Opus (1M context)" until
             * the window became a setting — a label carrying an answer to a
             * question the pill next door now asks properly.
             */
            label={label}
            {...(effort ? { detail: effortLabel(effort) } : {})}
            ariaLabel={`Model: ${label} on ${PROVIDER_LABEL[driver]}`}
            // Shrinks rather than forcing the row to overflow: the composer
            // shares the window with the right panel and cannot assume width.
            // Wider than the other pills — versioned model names ("Haiku 4.5")
            // are the longest labels this row carries.
            className="min-w-0 max-w-56 justify-start"
          />
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        // FIXED, IDENTICAL DIMENSIONS ON EVERY PROVIDER AND VIEW — h-[26rem],
        // not max-h. The menu used to be as tall as its list: Claude's four
        // rows made a short box, OpenCode's two hundred a full-height one, and
        // switching the rail visibly re-shaped the popover under the pointer.
        // One size means the rail, the search field and the footer never move;
        // only the scrollable middle changes. w-88 gives the wider rows (mark,
        // name, connection badge, Default, tick, star) their room; 70vh still
        // caps it on a short window.
        className="h-[min(26rem,70vh)] w-[22rem] flex-col gap-0 overflow-hidden rounded-xl p-0"
      >
        {/**
         * THE RAIL — the donor's own column, star and all.
         *
         * The provider belongs HERE rather than in an overflow menu, and not
         * only to shorten the row: which provider you are on decides which
         * models exist, so the two questions are one question. The STAR is the
         * same kind of entry and sits above them, because a favourite is a model
         * you chose over the provider's ordering — it answers "which models do I
         * actually use" without first answering "on which harness".
         */}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 p-1.5">
            <button
              type="button"
              onClick={() => {
                setView("favorites");
                setShowLegacy(false);
                setQuery("");
              }}
              aria-label="Favourites"
              title="Favourites"
              className={cn(
                "flex size-8 items-center justify-center rounded-lg transition-colors",
                view === "favorites"
                  ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <StarIcon className={cn("size-4", view === "favorites" && "fill-current text-primary")} />
            </button>
            {PROVIDERS.map((option) => (
              <button
                key={option}
                type="button"
                // Safe here and nowhere else in the composer: this content is
                // portalled, so it is outside `InputGroup`'s `has-disabled` reach.
                // The CURRENT provider stays live even when locked, because it is
                // how you get back from the favourites view.
                disabled={!onDriverChange && option !== driver}
                onClick={() => {
                  setView(option);
                  setShowLegacy(false);
                  setQuery("");
                  if (option !== driver) onDriverChange?.(option);
                }}
                aria-label={PROVIDER_LABEL[option]}
                title={onDriverChange || option === driver ? PROVIDER_LABEL[option] : `${PROVIDER_LABEL[option]} — fixed for this session`}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors disabled:cursor-default",
                  option === view
                    ? "bg-accent text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  option !== driver && !onDriverChange && "opacity-40",
                )}
              >
                <ProviderIcon provider={option} size={15} />
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* THE SEARCH FIELD — fixed above the scroll, part of the menu's
                constant chrome. Arrow-down hands focus to the list; typing
                narrows by name, routing id and connection. */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    document.getElementById(MODEL_LIST_ID)?.querySelector("button")?.focus();
                  }
                }}
                placeholder={view === "favorites" ? "Search favourites…" : `Search ${PROVIDER_LABEL[view]} models…`}
                aria-label="Search models by name or connection"
                className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
              />
              {searching && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="shrink-0 rounded px-1 text-[0.625rem] text-muted-foreground hover:text-foreground"
                >
                  clear
                </button>
              )}
            </div>
            <div
              id={MODEL_LIST_ID}
              className="min-h-0 flex-1 overflow-y-auto p-1"
              // Arrow keys walk the rows themselves — the search field above
              // and the star beside each row stay on the tab ring only.
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                const rows = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-row]") ?? [])];
                const at = rows.findIndex((row) => row === document.activeElement);
                if (at === -1) return;
                event.preventDefault();
                const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
                if (next < 0) (event.currentTarget.previousElementSibling?.querySelector("input") as HTMLInputElement | null)?.focus();
                else rows[next]?.focus();
              }}
            >
            {view === "favorites" && <MenuHeading>Favourites</MenuHeading>}
            {listed.map(({ from, family }) => (
              <FamilyRow
                key={`${from}:${family.id}`}
                family={family}
                driver={from}
                {...(crossProvider ? { provider: from } : {})}
                selected={from === driver && family.id === selectedFamily?.id}
                starred={favorites.has(family.id)}
                readOnly={readOnly}
                onSelect={() => pickFamily(family, from)}
                onStar={() => starFamily(from, family.id)}
              />
            ))}
            {/**
             * OLDER GENERATIONS, FOLDED. A provider's list grows and never
             * shrinks — Codex reports seven models and four of them are
             * previous families kept for people who pinned them. The rule is
             * "older than the provider's own default" rather than a list of ids
             * this repository would have to keep editing: see
             * lib/model-generations.ts. A STARRED model is never in here, whoever
             * it is older than.
             */}
            {view !== "favorites" && !searching && legacy.length > 0 && !showLegacy && (
              <button
                type="button"
                onClick={() => setShowLegacy(true)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60"
              >
                <span className="min-w-0 flex-1 truncate">Legacy models</span>
                <span className="shrink-0 text-[0.625rem]">{legacy.length}</span>
                <ChevronRightIcon className="size-3.5 shrink-0" />
              </button>
            )}
            {/* A model this catalogue does not list — set by another client, or
                added upstream since. Shown so the session never reads as running
                something it is not. */}
            {view !== "favorites" && !searching && choice.model && models.length > 0 && !selectedFamily && (
              <CompactRow label={choice.model} hint="external" selected disabled onSelect={() => undefined} />
            )}
            {asking && <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">Asking {PROVIDER_LABEL[asking]}…</p>}
            {/* Nothing to show, and the reasons are different questions. */}
            {searching && listed.length === 0 && (
              <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">Nothing matches “{query.trim()}” — names, ids and connections are searched.</p>
            )}
            {view === "favorites" && !asking && !searching && listed.length === 0 && (
              <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">Star a model to keep it here.</p>
            )}
            {view !== "favorites" && !searching && catalogue && models.length === 0 && (
              <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
                {catalogue.message ?? `${PROVIDER_LABEL[driver]} did not report any models.`}
              </p>
            )}
            </div>
          </div>
        </div>
        <p className="border-t border-border px-2.5 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
          {readOnly ? "Chosen when the session starts." : onDriverChange ? "Applies to the first message." : "Takes effect next turn."}
          {/* Whether this list was ASKED FOR or guessed. The distinction matters
              the moment an id here 404s at the provider — and it is read PER ROW
              rather than off the length, because a catalogue the provider could
              not answer plus a model somebody typed is a list with rows in it
              and nothing built-in about it. */}
          {catalogue?.source === "builtin" && models.some((row) => row.source !== "user") ? " Built-in list." : ""}
          {models.some((row) => row.source === "user") ? " Includes models you added." : ""}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * HOW HARD TO THINK — the donor's reasoning pill, on the vocabulary the engine
 * can actually carry.
 *
 * The donor drove a per-turn option matrix the engine contract does not have, so
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
 *
 * AND IT CARRIES THE CONTEXT WINDOW, which is what the pill's `Extra high · 1M`
 * is. The window used to be part of the model's NAME, because the provider
 * publishes it as a separate model — but a name is not a control, and "which
 * model" and "how much of it can I fill" are two questions that were being
 * answered in one list. The reference cockpit reads them exactly this way round.
 */
export function ReasoningControl({
  driver,
  choice,
  instanceId,
  onChange,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  /** Whose login's curated list to read. Absent means the built-in slot. */
  instanceId?: string;
  onChange?: (next: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const catalogue = useModelCatalogue(driver, instanceId);
  /**
   * PER MODEL, not per provider. Codex reports six levels for its newest model
   * and four for an older one, and offering a level a model does not have fails
   * the whole turn. `selectionOf` resolves the model the next turn will run —
   * including through an alias — and everything below is that row's own answer.
   *
   * FAST MODE IS PER MODEL TOO, AND THE MODEL SAYS SO. It used to be gated on
   * `driver === "claude"` — right that Codex has no equivalent, wrong that every
   * Claude model does. Of the rows the installed Claude Code reports, two
   * support it; the group is absent on the rest, because a switch that silently
   * does nothing is the thing this cockpit keeps refusing to ship.
   */
  const models = catalogue?.models ?? [];
  const { family, levels, fastMode, window: activeWindow, windows } = selectionOf(models, choice);
  const readOnly = !onChange;
  const effort = effortLabel(choice.effort);
  const suffix = windowSuffix(activeWindow, windows);
  /** `Extra high · 1M`. The window rides on the LABEL rather than in `detail`,
   *  which the pill hides at anything but the narrowest width — a fact you can
   *  only see by opening a menu is the thing this row exists to avoid. */
  const label = suffix ? `${effort} · ${suffix}` : effort;

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
            {...(choice.fastMode ? { detail: "Fast" } : {})}
            ariaLabel={`Reasoning effort: ${effort}${suffix ? `, ${suffix} context` : ""}`}
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
        {/* NO HAND-WRITTEN FALLBACK LIST. There used to be one, per provider, and
            it was wrong: it offered Haiku three levels, which supports none. Auto
            is the honest floor until the provider answers — and if it could not
            be asked, its own words say why. */}
        {levels.length === 0 && catalogue?.message && (
          <p className="px-2 py-1.5 text-[0.6875rem] leading-snug text-muted-foreground">{catalogue.message}</p>
        )}

        {/**
         * THE CONTEXT WINDOW, WHERE THE MODEL HAS MORE THAN ONE.
         *
         * Absent otherwise, and that is the whole reason this is derived from
         * the catalogue rather than from a flag: the switch this replaces was a
         * hand-kept `long` per model, and it offered a 1M window on models that
         * do not have one. Opus is 1M-only today and Haiku standard-only, so
         * neither shows a choice — the pill still says which, so nothing about
         * the next turn is hidden.
         *
         * PICKING ONE PICKS A MODEL — `sonnet` or `sonnet[1m]` — which is how
         * the provider publishes it. `withModel` drops anything the other row
         * cannot honour.
         */}
        {windows.length > 1 && family && (
          <div className="mt-1 border-t border-border pt-1">
            <MenuHeading>Context window</MenuHeading>
            {windows.map((option) => {
              const row = rowFor(family, option);
              return (
                <CompactRow
                  key={option}
                  label={WINDOW_LABEL[option]}
                  // The provider's own default window for this model — a fact
                  // to read, never a choice made for you: picking the model
                  // still sends the row you pick.
                  {...(row?.defaultWindow ? { hint: "Default" } : {})}
                  selected={activeWindow === option}
                  disabled={readOnly || !row}
                  onSelect={() => row && pick(withModel(choice, row))}
                />
              );
            })}
          </div>
        )}

        {fastMode && (
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
  instanceId,
}: {
  driver: ProviderDriverKind;
  choice: ModelChoice;
  /** Whose login's curated list to read. Absent means the built-in slot. */
  instanceId?: string;
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
  const catalogue = useModelCatalogue(driver, instanceId);
  // Same per-model rules as the pill's menus, from the same function — see
  // `selectionOf`, which exists because these two drifted apart once already.
  const models = catalogue?.models ?? [];
  const { family, levels, fastMode, window: activeWindow, windows } = selectionOf(models, choice);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More composer settings"
            title="More settings"
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

        {/* The window is a pill setting too, so it is here for the same reason
            everything else is: a narrow composer must not take a control away. */}
        {onChange && windows.length > 1 && family && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Context window</DropdownMenuLabel>
              {windows.map((option) => {
                const row = rowFor(family, option);
                return (
                  <DropdownMenuItem key={option} onClick={() => row && onChange(withModel(choice, row))}>
                    <span className="flex-1">{WINDOW_LABEL[option]}</span>
                    {row?.defaultWindow && <span className="shrink-0 text-[0.625rem] text-muted-foreground">Default</span>}
                    {activeWindow === option && <CheckIcon className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}

        {onChange && fastMode && (
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
 * IT RENDERS EVEN WHEN THE FIGURE IS UNKNOWN, showing an em dash. Both drivers
 * populate `contextUsed`/`contextMax` now (Codex from tokenUsage updates,
 * Claude per assistant envelope plus `modelUsage.contextWindow`), so an em
 * dash means the turn has not reported yet — the honest shape either way: a
 * gauge that disappears makes the row jump, and one that prints `0%` measures
 * nothing while looking like a reading.
 *
 * `onCompact` puts a Compact button in the popover — the caller decides which
 * provider gets one, because the gesture is a `/compact` prompt only Claude
 * executes.
 */
export function ContextPill({
  usage,
  driver,
  onCompact,
  compactDisabled,
  compactReason,
}: {
  usage?: UsageSnapshot;
  driver?: ProviderDriverKind;
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** Why the button is disabled, shown as its tooltip — "a turn is running",
   *  "already compacting". */
  compactReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const used = usage?.contextUsed;
  const max = usage?.contextMax;
  const unknown = used === undefined;
  const usedPct = used === undefined || max === undefined || max <= 0 ? null : Math.min(100, Math.max(0, (used / max) * 100));
  /** Past 90% the next long tool result can overflow the window — the ring
   *  turns to the app's danger colour so the state is visible without opening
   *  the popover. */
  const critical = usedPct !== null && usedPct > 90;

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
            className="relative flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={`Context window${unknown ? ", size not reported" : usedPct === null ? "" : ` ${usedPct.toFixed(1)}% used`}`}
            title="Context window"
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
            className={critical ? "text-destructive" : "text-primary"}
          />
        </svg>
        {/* THE RING IS THE READING. There used to be a figure in the middle —
            a percentage when the window was known, a raw token count while
            the turn was still reporting — and a 32px circle cannot hold
            "38.7k" without overflowing it. The arc says how full at a glance;
            the exact numbers are one click away in the card. */}
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
          {unknown && <p className="mt-3 max-w-56 text-sm leading-snug text-muted-foreground">{harness} does not report context size yet.</p>}
          <p className="mt-5 max-w-56 text-sm leading-snug text-muted-foreground">{harness} compacts automatically when needed.</p>
          {onCompact && (
            <button
              type="button"
              disabled={compactDisabled}
              title={compactDisabled ? compactReason : "Summarise the conversation to free space"}
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Minimize2Icon className="size-3.5" />
              Compact now
            </button>
          )}
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
      <span className="flex items-center gap-2 text-[0.6875rem] font-medium text-muted-foreground">
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
