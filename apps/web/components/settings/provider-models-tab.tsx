"use client";

/**
 * ONE LOGIN'S MODEL LIST, AS ITS READER WANTS IT.
 *
 * IT IS NOT A REGISTRY, and that distinction is the whole design. Every row here
 * came from ASKING the installed harness (apps/engine/src/models.ts) — Codex
 * answers `model/list`, Claude Code answers `supportedModels()` on its
 * initialize handshake. What this tab stores is only what the reader did to that
 * answer: starred, hidden, and the ids they typed because the CLI has not begun
 * publishing them yet. The hand-written catalogue this app deleted (it shipped a
 * `gpt-5.5-codex` that never existed) is not coming back.
 *
 * ROWS, NOT FAMILIES. The composer's picker folds `sonnet` and `sonnet[1m]` into
 * one model with a window control, which is right for choosing. It is wrong for
 * curating: they are two ids, and hiding the 1M variant while keeping the
 * standard one is a thing somebody may reasonably want.
 *
 * `+ Add` IS THE POINT OF THE WHOLE FEATURE. A model can ship, a login can be
 * entitled to it, and the installed CLI can still not list it — which is exactly
 * how this work started. One text field beats waiting for a release.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import type { CustomProviderModel, ModelCatalogue, ModelOverlay, ProviderInstance, ProviderModel } from "@telar/engine-client";
import { cn } from "@/lib/utils";
import { createEngineApi } from "@/lib/engine/client";
import { forgetModelCatalogues } from "@/lib/model-catalogue-cache";
import { DRIVER_LABEL } from "@/lib/provider-instances";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const api = createEngineApi();

/**
 * Can this id be added, and if not, why not?
 *
 * REFUSES WITH A REASON RATHER THAN NO-OPPING. "Nothing happened" on a button
 * press is the failure mode a person retypes their way around; naming the row
 * that already covers it is one sentence and ends the confusion. Exported for
 * test, the way `publishableEnv` already is on the sibling card.
 */
export function addableModelId(
  input: string,
  models: readonly ProviderModel[],
  custom: readonly CustomProviderModel[],
  driverLabel: string,
): { id: string } | { error: string } {
  const id = input.trim();
  if (!id) return { error: "Type a model id first." };
  // Matched the way `rowOf` matches — on the id, and on what an alias resolves
  // to — so `fable` covering `claude-fable-5-1` is caught here rather than
  // becoming a duplicate row the engine then silently drops.
  const covered = models.find((model) => model.source !== "user" && (model.id === id || model.resolves === id));
  if (covered) return { error: `${driverLabel} already lists this, as “${covered.label}”.` };
  if (custom.some((entry) => entry.id === id)) return { error: "You have already added this one." };
  return { id };
}

/** Toggle an id's membership of one of the overlay's lists. */
function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

/**
 * Move one row one place, as a new PARTIAL order.
 *
 * THE RESULT NAMES A PREFIX, NOT THE WHOLE LIST, and that is the property worth
 * protecting: the overlay's `order` pins the ids it names and lets everything
 * else follow the provider's own order, so a model the provider ships next week
 * lands where the provider put it instead of sorting last behind a total order
 * nobody has revised.
 *
 * THE PREFIX NEVER SHRINKS. Truncating to just this move would un-pin rows the
 * reader had already placed further down, which is a reorder undoing an earlier
 * one — so the cut is the longer of "what this move needs" and "what was already
 * named".
 *
 * Out-of-range moves return the previous order UNCHANGED rather than throwing or
 * clamping: the button at the end of the list is disabled, and a keyboard repeat
 * that outruns the render should do nothing rather than something surprising.
 */
export function reorderIds(
  rendered: readonly string[],
  previousOrder: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const from = rendered.indexOf(id);
  if (from < 0) return [...previousOrder];
  const to = from + direction;
  if (to < 0 || to >= rendered.length) return [...previousOrder];
  const next = [...rendered];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.slice(0, Math.max(from, to) + 1 > previousOrder.length ? Math.max(from, to) + 1 : previousOrder.length);
}

/** "7 from Claude · 1 you added · 2 hidden" — only the clauses that are true. */
/** The engine's own rule (`chosenDefault`): a row the provider withdrew or
 *  somebody typed never becomes what runs when nobody chose. */
export function canBeDefault(model: ProviderModel): boolean {
  return !model.hidden && model.source !== "user";
}

export function modelCountLine(models: readonly ProviderModel[], driverLabel: string): string {
  const published = models.filter((model) => model.source !== "user").length;
  const added = models.length - published;
  const hidden = models.filter((model) => model.hiddenByUser).length;
  return [
    `${published} from ${driverLabel}`,
    ...(added > 0 ? [`${added} you added`] : []),
    ...(hidden > 0 ? [`${hidden} hidden`] : []),
  ].join(" · ");
}

export function ProviderModelsTab({ instance }: { instance: ProviderInstance }) {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | undefined>();
  const [overlay, setOverlay] = useState<ModelOverlay | undefined>();
  const [draft, setDraft] = useState("");
  /**
   * THE ORDER AS IT LOOKS RIGHT NOW, while a burst of presses settles.
   *
   * Reorder is the one control here that does not follow the card's
   * one-write-per-commit rule, and the reason is the gesture: a blur is one
   * event, whereas pressing an arrow four times in a second is four, and the
   * last three writes would race each other over one array. So the list moves
   * immediately and the write is debounced behind it.
   */
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const orderTimer = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [models, saved] = await Promise.all([
      api.modelCatalogue(instance.driver, { instanceId: instance.id }),
      api.modelOverlay(instance.id),
    ]);
    setCatalogue(models.catalogue);
    setOverlay(saved.overlay);
  }, [instance.driver, instance.id]);

  /**
   * DEFERRED THROUGH A TIMEOUT, like every other engine read in this app. The
   * lint rule forbids a synchronous `setState` inside an effect (it is the
   * cascade that makes a render depend on its own side effect); a task scheduled
   * for the next tick is the shape the rest of these panes already use.
   */
  useEffect(() => {
    let live = true;
    const task = window.setTimeout(() => {
      void load().catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "Could not read this login's models.");
      });
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(task);
    };
  }, [load]);

  /**
   * Every accepted write forgets the composer's page-lifetime catalogue cache.
   * Without it, hiding a model here and opening the picker in the same session
   * would still show it — the settings pane and the composer are different
   * routes of one app, and only this call connects them.
   */
  const patch = async (next: Parameters<typeof api.setModelOverlay>[1]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setModelOverlay(instance.id, next);
      setOverlay(result.overlay);
      forgetModelCatalogues();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change was not saved.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => () => {
    if (orderTimer.current !== null) window.clearTimeout(orderTimer.current);
  }, []);

  const label = DRIVER_LABEL[instance.driver];
  const served = catalogue?.models ?? [];
  /** The server's list, re-sorted by whatever is still in flight. Stable sort,
   *  so rows the pending order does not name keep their places. */
  const models = useMemo(() => {
    if (!pendingOrder) return served;
    const rank = new Map(pendingOrder.map((id, index) => [id, index]));
    return [...served].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [served, pendingOrder]);

  if (!catalogue || !overlay) {
    return <p className="text-xs-plus text-muted-foreground">{error ?? `Asking ${label}…`}</p>;
  }

  const move = (id: string, direction: -1 | 1) => {
    const next = reorderIds(models.map((model) => model.id), pendingOrder ?? overlay.order, id, direction);
    setPendingOrder(next);
    if (orderTimer.current !== null) window.clearTimeout(orderTimer.current);
    orderTimer.current = window.setTimeout(() => {
      orderTimer.current = null;
      // `load()` inside `patch` replaces the served list, at which point the
      // optimistic copy has nothing left to say.
      void patch({ order: next }).finally(() => setPendingOrder(null));
    }, 400);
  };

  const add = () => {
    const result = addableModelId(draft, models, overlay.custom, label);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setDraft("");
    void patch({ custom: [...overlay.custom, { id: result.id }] });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-xs-plus text-muted-foreground">{modelCountLine(models, label)}</p>
        {/* The provider's own words when it could not answer — never a paraphrase. */}
        {catalogue.message && <p className="text-xs-plus text-warning">{catalogue.message}</p>}
      </div>

      <div className="divide-y divide-border/60 rounded-lg border border-border/70 bg-card">
        {models.map((model, index) => {
          const starred = overlay.favorites.includes(model.id);
          const added = model.source === "user";
          return (
            <div
              key={model.id}
              className={cn("group flex items-center gap-2 px-2.5 py-1.5", model.hiddenByUser && "opacity-55")}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => void patch({ favorites: toggled(overlay.favorites, model.id) })}
                aria-label={`${starred ? "Unstar" : "Star"} ${model.label}`}
                title={starred ? "Starred — kept at the top of the picker" : "Star"}
                className={cn("shrink-0 rounded-sm transition-colors", starred ? "text-warning" : "text-muted-foreground/50 hover:text-foreground")}
              >
                <StarIcon className={cn("size-3.5", starred && "fill-current")} />
              </button>
              <span className={cn("min-w-0 truncate text-xs-plus", model.hiddenByUser && "line-through")}>{model.label}</span>
              <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">{model.id}</code>
              {model.isDefault && <span className="shrink-0 text-3xs text-muted-foreground">Default</span>}
              {/* The reader's own default can be handed back to Telar's pick;
                  any other row a session could run can take its place. */}
              {model.isDefault && overlay.default === model.id ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void patch({ default: null })}
                  className="shrink-0 text-3xs text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  Reset
                </button>
              ) : (
                !model.isDefault &&
                canBeDefault(model) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void patch({ default: model.id })}
                    className="shrink-0 text-3xs text-muted-foreground/70 opacity-0 underline-offset-2 transition-opacity group-hover:opacity-100 hover:text-foreground hover:underline focus-visible:opacity-100"
                  >
                    Make default
                  </button>
                )
              )}
              {added && <span className="shrink-0 text-3xs text-muted-foreground">added by you</span>}
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => move(model.id, -1)}
                  aria-label={`Move ${model.label} up`}
                  className="rounded-sm p-1 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-25"
                >
                  <ArrowUpIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={index === models.length - 1}
                  onClick={() => move(model.id, 1)}
                  aria-label={`Move ${model.label} down`}
                  className="rounded-sm p-1 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-25"
                >
                  <ArrowDownIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void patch({ hidden: toggled(overlay.hidden, model.id) })}
                  aria-label={`${model.hiddenByUser ? "Show" : "Hide"} ${model.label}`}
                  title={model.hiddenByUser ? "Hidden from the picker" : "Hide from the picker"}
                  className="rounded-sm p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  {model.hiddenByUser ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </button>
                {/* Only on rows somebody typed: a published row is not this
                    cockpit's to remove, only to hide. */}
                {added && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void patch({ custom: overlay.custom.filter((entry) => entry.id !== model.id) })}
                    aria-label={`Remove ${model.id}`}
                    className="rounded-sm p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {models.length === 0 && (
          <p className="px-2.5 py-3 text-xs-plus text-muted-foreground">
            {label} did not report any models. You can still add one below.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => event.key === "Enter" && add()}
            placeholder={instance.driver === "claude" ? "claude-fable-5-1" : "gpt-6.7-codex-ultra-preview"}
            aria-label="Model id to add"
            className="h-8 text-xs-plus"
          />
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2 text-xs" disabled={busy} onClick={add}>
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
        {error && <p className="text-xs-plus text-destructive">{error}</p>}
        {/* The sentence that keeps this honest. */}
        <p className="text-[0.75rem] leading-snug text-muted-foreground/80">
          Telar never invents models. An id here is sent to {label} exactly as typed, and a harness that does not have it
          refuses the turn in its own words.
        </p>
      </div>
    </div>
  );
}
