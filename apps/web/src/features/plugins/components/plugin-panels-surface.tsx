"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { parsePluginPanelView, type PluginPanelBlock, type TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { panelSourceKey, type PluginPanelSource } from "../panels";
import { cn } from "@/ui/utils";
import { PluginBlocks } from "./panel-blocks";

const api = createEngineApi();

type View = { status: "loading" } | { status: "ready"; blocks: PluginPanelBlock[] } | { status: "failed"; error: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function PluginPanelsSurface({
  sessionId,
  panels,
  active,
}: {
  sessionId?: string;
  panels: readonly PluginPanelSource[];
  active?: TurnState;
}) {
  const [chosen, setChosen] = useState<string>();
  const source = panels.find((candidate) => panelSourceKey(candidate) === chosen) ?? panels[0];
  const [view, setView] = useState<View>({ status: "loading" });
  const [pending, setPending] = useState<number>();

  const read = useCallback(async () => {
    if (!sessionId || !source) return;
    try {
      const answer = await api.sessionPluginVerb(sessionId, source.plugin, source.panel.verb);
      setView({ status: "ready", blocks: parsePluginPanelView(answer).blocks });
    } catch (error) {
      setView({ status: "failed", error: message(error) });
    }
  }, [sessionId, source]);

  useEffect(() => {
    const task = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(task);
  }, [read, active]);

  if (!sessionId) return <p className="p-4 text-xs text-muted-foreground">Start the conversation to see plugin panels.</p>;
  if (!source) return <p className="p-4 text-xs text-muted-foreground">No enabled plugin has a panel.</p>;

  const act = async (block: Extract<PluginPanelBlock, { type: "action" }>, index: number) => {
    setPending(index);
    try {
      await api.sessionPluginVerb(sessionId, source.plugin, block.verb, block.input ?? {});
      await read();
    } catch (error) {
      setView({ status: "failed", error: message(error) });
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        {panels.length > 1 &&
          panels.map((candidate) => (
            <button
              key={panelSourceKey(candidate)}
              type="button"
              onClick={() => setChosen(panelSourceKey(candidate))}
              className={cn(
                "rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/60",
                candidate === source && "bg-muted text-foreground",
              )}
            >
              {candidate.pluginName} · {candidate.panel.label}
            </button>
          ))}
        {panels.length === 1 && <span className="px-1 text-xs text-muted-foreground">{source.pluginName} · {source.panel.label}</span>}
        <button type="button" aria-label="Refresh" onClick={() => void read()} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted/60">
          <RefreshCwIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {view.status === "loading" && <p className="text-xs text-muted-foreground">Loading…</p>}
        {view.status === "failed" && <p className="text-xs text-destructive">{view.error}</p>}
        {view.status === "ready" && <PluginBlocks blocks={view.blocks} {...(pending !== undefined ? { pending } : {})} onAction={(block, index) => void act(block, index)} />}
      </div>
    </div>
  );
}
