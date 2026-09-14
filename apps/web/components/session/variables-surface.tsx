"use client";

/**
 * THE KERNEL'S NAMESPACE, at a glance. One row per variable with type and
 * size; click to inspect. Reads only — a kernel that has not started is not
 * started by opening this (the pill says "no kernel" and the list is empty).
 */
import { useCallback, useEffect, useState } from "react";
import { BracesIcon, RotateCwIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { humanBytes, type KernelState, type VarRow } from "@/lib/ds";
import { PanelEmpty, PanelHeader } from "@/components/ui/panel";
import { KernelPill } from "./kernel-pill";
import { cn } from "@/lib/utils";

const api = createEngineApi();

/** `embedded`: inside the Data tab, whose strip already shows the kernel pill. */
export function VariablesSurface({ sessionId, active, embedded }: { sessionId?: string; active?: TurnState; embedded?: boolean }) {
  const [kernel, setKernel] = useState<KernelState>("none");
  const [vars, setVars] = useState<VarRow[]>([]);
  const [open, setOpen] = useState<string>();
  const [detail, setDetail] = useState<Record<string, unknown>>();
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.kernel(sessionId);
      setKernel(status.state);
      if (status.state !== "none" && status.state !== "dead") setVars(await api.kernelVars(sessionId));
      else setVars([]);
    } catch {
      setKernel("none");
    }
  }, [sessionId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load, active]);

  const inspect = async (name: string) => {
    if (!sessionId) return;
    if (open === name) { setOpen(undefined); return; }
    setOpen(name);
    setDetail(undefined);
    setDetail(await api.kernelInspect(sessionId, name));
  };

  if (!sessionId) return <PanelEmpty icon={<BracesIcon />} title="No session" />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        {...(embedded ? {} : { icon: <BracesIcon /> })}
        label={embedded ? "" : "Variables"}
        className={cn(embedded && "border-b-0 py-1")}
        // A COUNT NEEDS A WORD BESIDE IT. Embedded, this header has no label —
        // the Data tab's sub-strip names the surface — so the count rendered as
        // a bare `12` in the top-left corner, a number with nothing to be a
        // count OF (#357). The strip above already says Variables and the list
        // below is the count; an empty namespace says so in its own words.
        {...(embedded ? {} : { count: vars.length })}
        actions={
          <span className="flex items-center gap-1.5">
            {!embedded && <KernelPill state={kernel} />}
            <button type="button" aria-label="Refresh" onClick={() => { setRefreshing(true); void load().finally(() => setRefreshing(false)); }} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <RotateCwIcon className={cn("size-3", refreshing && "animate-spin")} />
            </button>
          </span>
        }
      />
      {vars.length === 0 ? (
        <PanelEmpty icon={<BracesIcon />} title={kernel === "none" ? "No kernel yet" : "Empty namespace"}>
          {kernel === "none" ? "Run a cell or ask the agent to use ds_scratch." : "Nothing assigned since the last restart."}
        </PanelEmpty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {vars.map((row) => (
            <div key={row.name} className="border-b border-border/60">
              <button type="button" onClick={() => void inspect(row.name)} className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring", open === row.name && "bg-muted/40")}>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-foreground">{row.name}</span>
                <span className="shrink-0 truncate font-mono text-[0.625rem] text-muted-foreground">{row.type}</span>
                <span className="w-24 shrink-0 text-right font-mono text-[0.625rem] text-muted-foreground tabular-nums">
                  {row.shape ? row.shape.join("×") : row.len !== undefined ? `len ${row.len}` : ""}
                </span>
                <span className="w-16 shrink-0 text-right font-mono text-[0.625rem] text-muted-foreground tabular-nums">{row.sizeBytes ? humanBytes(row.sizeBytes) : ""}</span>
              </button>
              {open === row.name && (
                <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap border-t border-border/40 bg-muted/20 px-3 py-2 font-mono text-[0.625rem] leading-[1.5]">
                  {detail ? JSON.stringify(detail, null, 2) : "…"}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
