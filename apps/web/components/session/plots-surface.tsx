"use client";

/**
 * EVERY FIGURE THE SESSION MADE, newest first, with a pin.
 *
 * A plot is an attachment tagged `plot` — the same store the composer's
 * uploads go to — so this is a filtered read of the index and nothing more.
 * Pinning writes a `pinned` tag; pinned plots sort first. Click opens the
 * lightbox; the composer can reference a plot by dragging it.
 */
import { useCallback, useEffect, useState } from "react";
import { ChartLineIcon, PinIcon, PinOffIcon, RotateCwIcon } from "lucide-react";
import type { TurnAttachment, TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { attachmentUrl } from "@/lib/ds";
import { PanelEmpty, PanelHeader } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** `embedded`: drawn inside the Data tab's sub-strip, which already carries the kernel pill — so no header of its own. */
export function PlotsSurface({ sessionId, active, onOpenImage, embedded }: { sessionId?: string; active?: TurnState; onOpenImage?: (attachmentId: string) => void; embedded?: boolean }) {
  const [plots, setPlots] = useState<TurnAttachment[]>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const answer = await api.attachments(sessionId, { tag: "plot" });
      setPlots(answer.attachments);
    } catch {
      setPlots([]);
    }
  }, [sessionId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  const pin = async (plot: TurnAttachment) => {
    if (!sessionId) return;
    const tags = plot.tags ?? [];
    const next = tags.includes("pinned") ? tags.filter((t) => t !== "pinned") : [...tags, "pinned"];
    await api.tagAttachment(sessionId, plot.id, next);
    void load();
  };

  if (!sessionId) return <PanelEmpty icon={<ChartLineIcon />} title="No session">Plots belong to a session&apos;s kernel.</PanelEmpty>;
  const sorted = [...(plots ?? [])].sort((a, b) => Number(b.tags?.includes("pinned") ?? false) - Number(a.tags?.includes("pinned") ?? false));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        {...(embedded ? {} : { icon: <ChartLineIcon /> })}
        label={embedded ? "" : "Plots"}
        className={cn(embedded && "border-b-0 py-1")}
        {...(plots ? { count: plots.length } : {})}
        actions={
          <button type="button" aria-label="Refresh" onClick={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
            <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
          </button>
        }
      />
      {plots && plots.length === 0 ? (
        <PanelEmpty icon={<ChartLineIcon />} title="No plots yet">
          A figure drawn in a notebook cell or by ds_plot lands here.
        </PanelEmpty>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-auto p-2 @[480px]:grid-cols-2">
          {sorted.map((plot) => {
            const pinned = plot.tags?.includes("pinned") ?? false;
            return (
              <figure key={plot.id} className={cn("group relative overflow-hidden rounded-md border border-border bg-white", pinned && "ring-1 ring-primary/50")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={attachmentUrl(sessionId, plot.id)}
                  alt={plot.producer ?? plot.name}
                  className="block w-full cursor-zoom-in object-contain"
                  onClick={() => onOpenImage?.(plot.id)}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("text/plain", `[plot ${plot.id}]`)}
                />
                <figcaption className="flex items-center gap-1.5 border-t border-border bg-background px-2 py-1 text-[0.625rem] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{plot.producer ?? plot.name}</span>
                  {plot.createdAt && <span className="shrink-0 tabular-nums">{new Date(plot.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                  <button type="button" title={pinned ? "Unpin" : "Pin to top"} onClick={() => void pin(plot)} className={cn("rounded p-0.5 hover:text-foreground", pinned ? "text-primary" : "opacity-0 group-hover:opacity-100")}>
                    {pinned ? <PinOffIcon className="size-3" /> : <PinIcon className="size-3" />}
                  </button>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}
