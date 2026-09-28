"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import type { CustomProviderModel, ModelCatalogue, ModelOverlay, ProviderInstance, ProviderModel } from "@telar/engine-client";
import { cn } from "@/ui/utils";
import { createEngineApi } from "@/platform/engine";
import { forgetModelCatalogues } from "../model-catalogue-cache";
import { DRIVER_LABEL } from "../provider-instances";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

const api = createEngineApi();

export function addableModelId(
  input: string,
  models: readonly ProviderModel[],
  custom: readonly CustomProviderModel[],
  driverLabel: string,
): { id: string } | { error: string } {
  const id = input.trim();
  if (!id) return { error: "Type a model id first." };
  const covered = models.find((model) => model.source !== "user" && (model.id === id || model.resolves === id));
  if (covered) return { error: `${driverLabel} already lists this, as “${covered.label}”.` };
  if (custom.some((entry) => entry.id === id)) return { error: "You have already added this one." };
  return { id };
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

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
        <p className="text-[0.75rem] leading-snug text-muted-foreground/80">
          Telar never invents models. An id here is sent to {label} exactly as typed, and a harness that does not have it
          refuses the turn in its own words.
        </p>
      </div>
    </div>
  );
}
