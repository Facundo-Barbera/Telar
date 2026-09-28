"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BracesIcon, ChartLineIcon, PackageIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import type { EngineEvent, TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { latestKernelState, type KernelState } from "./ds";
import { cn } from "@/ui/utils";
import { KernelPill } from "./kernel-pill";
import { PlotsSurface } from "./plots-surface";
import { VariablesSurface } from "./variables-surface";
import { EnvironmentSurface } from "./environment-surface";

const api = createEngineApi();

type SubTab = "plots" | "variables" | "environment";
const STORAGE_KEY = "telar.data.subtab";
const SUB_TABS: { id: SubTab; label: string; icon: typeof ChartLineIcon }[] = [
  { id: "plots", label: "Plots", icon: ChartLineIcon },
  { id: "variables", label: "Variables", icon: BracesIcon },
  { id: "environment", label: "Environment", icon: PackageIcon },
];

function readSubTab(): SubTab {
  if (typeof window === "undefined") return "plots";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return SUB_TABS.some((t) => t.id === stored) ? (stored as SubTab) : "plots";
}

export function DataSurface({
  sessionId,
  projectId,
  active,
  events = [],
  onOpenImage,
}: {
  sessionId?: string;
  projectId?: string;
  active?: TurnState;
  events?: readonly EngineEvent[];
  onOpenImage?: (attachmentId: string) => void;
}) {
  const [sub, setSub] = useState<SubTab>(readSubTab);
  const [read, setRead] = useState<KernelState>("none");
  const [acting, setActing] = useState<"interrupt" | "restart">();
  const journalled = useMemo(() => latestKernelState(events), [events]);
  const kernel = journalled ?? read;

  const choose = (next: SubTab) => {
    setSub(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* full or disabled storage */ }
  };

  const readKernel = useCallback(async () => {
    if (!sessionId) return;
    try {
      setRead((await api.kernel(sessionId)).state);
    } catch {
      setRead("none");
    }
  }, [sessionId]);

  useEffect(() => {
    const first = window.setTimeout(() => void readKernel(), 0);
    return () => window.clearTimeout(first);
  }, [readKernel, active]);

  const act = async (what: "interrupt" | "restart") => {
    if (!sessionId) return;
    setActing(what);
    try {
      if (what === "interrupt") await api.kernelInterrupt(sessionId);
      else await api.kernelRestart(sessionId);
    } finally {
      setActing(undefined);
      void readKernel();
    }
  };

  const live = kernel !== "none" && kernel !== "dead";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Data views">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            onClick={() => choose(tab.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              sub === tab.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <tab.icon className="size-3" />
            {tab.label}
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <KernelPill state={kernel} />
          {live && (
            <button type="button" title="Interrupt the running cell" aria-label="Interrupt kernel" disabled={acting !== undefined} onClick={() => void act("interrupt")} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <SquareIcon className="size-3" />
            </button>
          )}
          {kernel !== "none" && (
            <button type="button" title="Restart the kernel — clears every variable" aria-label="Restart kernel" disabled={acting !== undefined} onClick={() => void act("restart")} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <RotateCwIcon className={cn("size-3", acting === "restart" && "animate-spin")} />
            </button>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {sub === "plots" && <PlotsSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} {...(onOpenImage ? { onOpenImage } : {})} embedded />}
        {sub === "variables" && <VariablesSurface {...(sessionId ? { sessionId } : {})} {...(active ? { active } : {})} embedded />}
        {sub === "environment" && <EnvironmentSurface {...(sessionId ? { sessionId } : {})} {...(projectId ? { projectId } : {})} kernel={kernel} onRestart={() => void act("restart")} />}
      </div>
    </div>
  );
}
