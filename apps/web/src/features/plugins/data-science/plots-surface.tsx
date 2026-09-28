"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartLineIcon, PinIcon, PinOffIcon, RotateCwIcon } from "lucide-react";
import type { TurnAttachment, TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { attachmentUrl } from "./ds";
import { PanelEmpty, PanelHeader } from "@/ui/panel";
import { cn } from "@/ui/utils";

const api = createEngineApi();

export function plotLabel(plot: TurnAttachment): string {
  return plot.title?.trim() || plot.producer?.trim() || plot.name;
}

export function plotGroupKey(plot: TurnAttachment): string {
  const title = plot.title?.trim();
  if (title) return `title:${title.toLowerCase()}`;
  const producer = plot.producer?.trim();
  if (producer && !producer.startsWith("ds_")) return `producer:${producer}`;
  return `plot:${plot.id}`;
}

export type PlotStack = {
  key: string;
  versions: TurnAttachment[];
  latest: TurnAttachment;
  pinned: boolean;
};

export function stackPlots(plots: readonly TurnAttachment[]): PlotStack[] {
  const byKey = new Map<string, TurnAttachment[]>();
  for (const plot of plots) {
    const key = plotGroupKey(plot);
    const group = byKey.get(key);
    if (group) group.push(plot);
    else byKey.set(key, [plot]);
  }
  const stacks = [...byKey].map(([key, group]) => {
    const versions = [...group].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return { key, versions, latest: versions[0]!, pinned: versions.some((plot) => plot.tags?.includes("pinned") ?? false) };
  });
  return stacks.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (b.latest.createdAt ?? 0) - (a.latest.createdAt ?? 0),
  );
}

export function PlotsSurface({ sessionId, active, onOpenImage, embedded }: { sessionId?: string; active?: TurnState; onOpenImage?: (attachmentId: string) => void; embedded?: boolean }) {
  const [plots, setPlots] = useState<TurnAttachment[]>();
  const [refreshing, setRefreshing] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());

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

  const stacks = useMemo(() => stackPlots(plots ?? []), [plots]);

  if (!sessionId) return <PanelEmpty icon={<ChartLineIcon />} title="No session">Plots belong to a session&apos;s kernel.</PanelEmpty>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        {...(embedded ? {} : { icon: <ChartLineIcon /> })}
        label={embedded ? "" : "Plots"}
        className={cn(embedded && "border-b-0 py-1")}
        {...(!embedded && plots ? { count: stacks.length } : {})}
        actions={
          <button type="button" aria-label="Refresh" onClick={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
          {stacks.map((stack) => {
            const open = unfolded.has(stack.key);
            const older = stack.versions.slice(1);
            return (
              <div key={stack.key} className="flex min-w-0 flex-col gap-1">
                <PlotCard
                  sessionId={sessionId}
                  plot={stack.latest}
                  pinned={stack.pinned}
                  {...(onOpenImage ? { onOpen: onOpenImage } : {})}
                  onPin={() => void pin(stack.latest)}
                  versions={stack.versions.length}
                  open={open}
                  onToggleVersions={
                    older.length === 0
                      ? undefined
                      : () =>
                          setUnfolded((current) => {
                            const next = new Set(current);
                            if (!next.delete(stack.key)) next.add(stack.key);
                            return next;
                          })
                  }
                />
                {open &&
                  older.map((plot) => (
                    <PlotCard
                      key={plot.id}
                      sessionId={sessionId}
                      plot={plot}
                      pinned={plot.tags?.includes("pinned") ?? false}
                      {...(onOpenImage ? { onOpen: onOpenImage } : {})}
                      onPin={() => void pin(plot)}
                      superseded
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlotCard({
  sessionId,
  plot,
  pinned,
  onOpen,
  onPin,
  versions,
  open,
  onToggleVersions,
  superseded,
}: {
  sessionId: string;
  plot: TurnAttachment;
  pinned: boolean;
  onOpen?: (attachmentId: string) => void;
  onPin: () => void;
  versions?: number;
  open?: boolean;
  onToggleVersions?: () => void;
  superseded?: boolean;
}) {
  const label = plotLabel(plot);
  return (
    <figure
      className={cn(
        "group relative overflow-hidden rounded-md border border-border bg-white",
        pinned && "ring-1 ring-primary/50",
        superseded && "ml-3 opacity-70",
      )}
    >
      <img
        src={attachmentUrl(sessionId, plot.id)}
        alt={label}
        className="block w-full cursor-zoom-in object-contain"
        onClick={() => onOpen?.(plot.id)}
        draggable
        onDragStart={(event) => event.dataTransfer.setData("text/plain", `[plot ${plot.id}]`)}
      />
      <figcaption className="flex items-center gap-1.5 border-t border-border bg-background px-2 py-1 text-3xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
        {versions !== undefined && versions > 1 && onToggleVersions && (
          <button
            type="button"
            onClick={onToggleVersions}
            aria-expanded={open}
            title={open ? "Hide the earlier attempts" : `Show the ${versions - 1} this replaced`}
            className="shrink-0 rounded px-1 tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {versions} versions
          </button>
        )}
        {plot.createdAt && <span className="shrink-0 tabular-nums">{new Date(plot.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        <button type="button" title={pinned ? "Unpin" : "Pin to top"} onClick={onPin} className={cn("rounded p-0.5 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring", pinned ? "text-primary" : "opacity-0 group-hover:opacity-100")}>
          {pinned ? <PinOffIcon className="size-3" /> : <PinIcon className="size-3" />}
        </button>
      </figcaption>
    </figure>
  );
}
