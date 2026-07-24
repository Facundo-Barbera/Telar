"use client";
// LANE: prep-gate (UX brainstorm 2026-07-23) — shared pieces for the merged
// gate surface. The graph is a TRUE DAG rendered as a MAP: grab to pan,
// scroll to zoom, rounded 90° elbow edges, and node text that NEVER
// truncates (session verdict: "it's important to see what you are doing").
// Selecting a node re-centers and zooms the map on it — the zoom applies
// only to the graph, the conversation opens beside it. Waking + approval
// visibly GROWS a new edge into the flow compile.
import { useEffect, useRef, useState } from "react";
import {
  CircleCheckIcon,
  FlagIcon,
  Loader2Icon,
  LockIcon,
  LockOpenIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EDGES,
  GATE,
  NODES,
  PRD_WOKEN,
  WOKEN_EDGE,
  type PlanPreview,
} from "./fixtures";

export const ROW_PX = 140;
export const NODE_PX = 72; // uniform node height — edge anchors stay true
export const GRAPH_W = 960; // fixed layout width — pixel-true elbows
const GATE_ROW = 5;
export const GRAPH_H = GATE_ROW * ROW_PX + NODE_PX;

// Orthogonal edge with rounded 90° turns: down, elbow, across, elbow, down.
function elbow(x1: number, y1: number, x2: number, y2: number, r = 8) {
  if (Math.abs(x2 - x1) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  const dir = x2 > x1 ? 1 : -1;
  const rr = Math.min(r, Math.abs(x2 - x1) / 2, Math.max((y2 - y1) / 2, 1));
  return [
    `M ${x1} ${y1}`,
    `L ${x1} ${midY - rr}`,
    `Q ${x1} ${midY} ${x1 + dir * rr} ${midY}`,
    `L ${x2 - dir * rr} ${midY}`,
    `Q ${x2} ${midY} ${x2} ${midY + rr}`,
    `L ${x2} ${y2}`,
  ].join(" ");
}

// The minimal node shape the map needs — PrepGraphNode satisfies it, and
// other lanes (the cockpit's Prepare receipts) can feed their own graphs.
export type DagNodeSpec = {
  id: string;
  title: string;
  sub: string; // SHORT — one line on the map, never cut
  detail?: string; // full text — shown when the node expands on select
  state: "done" | "dormant";
  x: number; // horizontal center, 0..1
  row: number; // depth level, top → down
};

export function GateNode({
  node,
  selected,
  fresh,
  expanded,
  onOpen,
}: {
  node: DagNodeSpec;
  selected?: boolean;
  fresh?: boolean;
  expanded?: boolean; // selected nodes grow to show the FULL detail text
  onOpen?: () => void;
}) {
  const inner = (
    <>
      <div className="flex items-start gap-2">
        {node.state === "done" ? (
          <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <span className="mt-0.5 size-3 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
        )}
        <span className="min-w-0 flex-1 text-xs font-medium leading-snug">{node.title}</span>
        <span className="shrink-0 rounded border border-border/60 px-1 py-0.5 font-mono text-[8px] text-muted-foreground/50">
          session
        </span>
      </div>
      {expanded ? (
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-muted-foreground">
          {node.detail ?? node.sub}
        </p>
      ) : (
        <p className="mt-1 overflow-hidden whitespace-nowrap font-mono text-[9px] leading-snug text-muted-foreground/60">
          {node.sub}
        </p>
      )}
    </>
  );
  const classes = cn(
    "flex w-full min-w-0 flex-col rounded-xl border bg-card p-2.5",
    !expanded && "h-full overflow-hidden",
    expanded && "shadow-md",
    node.state === "dormant" ? "border-dashed border-border opacity-60" : "border-border",
    selected && "border-foreground/40",
    fresh && "border-foreground/40 bg-muted/30",
  );
  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(classes, "text-left transition-colors hover:border-foreground/25")}
      >
        {inner}
      </button>
    );
  }
  return <div className={classes}>{inner}</div>;
}

// The DAG as a map: grab to pan, scroll to zoom, click to enter a node.
// `focusId` re-centers and zooms toward that node ("gate" included); null
// fits the whole graph. The zoom is the graph's alone — panes live outside.
// Pass `nodes`/`edges` to render ANY loom's graph (the cockpit's Prepare
// receipts do); without them it renders the prep-gate fixtures with their
// live prd/wake/recompile behavior. gateState "sealed" = the frozen receipt.
export function GateGraph({
  woken = false,
  prdDrafting,
  recompiling,
  selected,
  freshId,
  onNode,
  focusId,
  nodes: nodesProp,
  edges: edgesProp,
  gateState = "open",
  gateSub = "Accept / Modify / Deny",
}: {
  woken?: boolean;
  prdDrafting?: boolean;
  recompiling?: boolean;
  selected?: string | null;
  freshId?: string | null;
  onNode?: (id: string) => void;
  focusId?: string | null;
  nodes?: DagNodeSpec[];
  edges?: [string, string][];
  gateState?: "open" | "sealed";
  gateSub?: string;
}) {
  const custom = !!nodesProp;
  const nodes: DagNodeSpec[] =
    nodesProp ?? NODES.map((n) => (n.id === "prd" && woken ? PRD_WOKEN : n));
  const px = (x: number) => x * GRAPH_W;
  const gateRow = Math.max(...nodes.map((n) => n.row)) + 1;
  const graphH = gateRow * ROW_PX + NODE_PX;
  const coords: Record<string, { x: number; row: number }> = Object.fromEntries(
    nodes.map((n) => [n.id, { x: n.x, row: n.row }]),
  );
  coords.gate = { x: 0.5, row: gateRow };

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges: { from: string; to: string; dashed: boolean; grown?: boolean }[] = (
    edgesProp ?? EDGES
  ).map(([from, to]) => ({
    from,
    to,
    dashed: custom
      ? byId[from]?.state === "dormant" || byId[to]?.state === "dormant"
      : (from === "prd" || to === "prd") && !woken && !prdDrafting,
  }));
  if (!custom && woken) {
    edges.push({ from: WOKEN_EDGE[0], to: WOKEN_EDGE[1], dashed: false, grown: true });
  }

  const viewportRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const [view, setView] = useState({ x: 0, y: 14, s: 0.9 });
  const [gliding, setGliding] = useState(false);

  // Fit on mount / re-center on focus change. The pane opening resizes the
  // viewport in the same commit, so measure AFTER layout settles (double
  // rAF) — measuring too early is what made the glide flicker.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        setGliding(true);
        if (!focusId) {
          const s = Math.min(0.95, (h - 28) / graphH, (w - 28) / GRAPH_W);
          setView({ s, x: (w - GRAPH_W * s) / 2, y: Math.max(14, (h - graphH * s) / 2) });
        } else {
          const c = coords[focusId];
          if (c) {
            const s = 1.2;
            setView({
              s,
              x: w / 2 - s * px(c.x),
              y: h / 2 - s * (c.row * ROW_PX + NODE_PX / 2),
            });
          }
        }
      });
    });
    const t = setTimeout(() => setGliding(false), 420);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  // Scroll = zoom, anchored at the cursor. Native listener: React's onWheel
  // can't preventDefault (passive).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const s = Math.min(2.2, Math.max(0.45, v.s * Math.exp(-e.deltaY * 0.0016)));
        const k = s / v.s;
        return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    movedRef.current = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      setView((v) => ({ ...v, x: start.vx + dx, y: start.vy + dy }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clickNode = (id: string) => {
    if (!movedRef.current && onNode) onNode(id);
  };

  return (
    <div
      ref={viewportRef}
      onPointerDown={onPointerDown}
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-muted/10 active:cursor-grabbing"
    >
      <div
        className="absolute"
        style={{
          height: graphH,
          width: GRAPH_W,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          transformOrigin: "0 0",
          transition: gliding ? "transform 380ms cubic-bezier(0.22, 1, 0.36, 1)" : undefined,
          willChange: "transform",
        }}
      >
        <svg
          aria-hidden
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${GRAPH_W} ${graphH}`}
        >
          {edges.map((e) => {
            const a = coords[e.from];
            const b = coords[e.to];
            if (!a || !b) return null;
            return (
              <path
                key={`${e.from}-${e.to}`}
                d={elbow(px(a.x), a.row * ROW_PX + NODE_PX, px(b.x), b.row * ROW_PX)}
                fill="none"
                strokeWidth={e.grown ? 1.75 : 1.25}
                strokeDasharray={e.dashed ? "3 3" : undefined}
                className={e.grown ? "stroke-foreground/40" : "stroke-border"}
              />
            );
          })}
        </svg>

        {nodes.map((n) => {
          const isSel = selected === n.id;
          return (
            <div
              key={n.id}
              className={cn(
                "absolute w-44 -translate-x-1/2 transition-opacity duration-200",
                isSel && "z-20",
                selected && !isSel && "opacity-65",
              )}
              style={{
                left: px(n.x),
                top: n.row * ROW_PX,
                height: isSel ? undefined : NODE_PX,
              }}
            >
              {!custom && n.id === "flow-compile" && recompiling ? (
                <div className="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card p-2.5">
                  <div className="flex items-start gap-2">
                    <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-foreground" />
                    <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                      Flow compile
                    </span>
                  </div>
                  <p className="mt-1 overflow-hidden whitespace-nowrap font-mono text-[9px] leading-snug text-muted-foreground/60">
                    recompiling — graph grew
                  </p>
                </div>
              ) : !custom && n.id === "prd" && prdDrafting ? (
                <button
                  type="button"
                  onClick={onNode ? () => clickNode(n.id) : undefined}
                  className={cn(
                    "flex w-full min-w-0 flex-col rounded-xl border border-foreground/40 bg-muted/30 p-2.5 text-left",
                    !isSel && "h-full overflow-hidden",
                    isSel && "border-foreground/60 shadow-md",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin text-foreground" />
                    <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                      PRD delta
                    </span>
                    <span className="shrink-0 rounded border border-border/60 px-1 py-0.5 font-mono text-[8px] text-muted-foreground/50">
                      session
                    </span>
                  </div>
                  <p
                    className={cn(
                      "mt-1 font-mono text-[9px] text-muted-foreground/60",
                      isSel
                        ? "leading-relaxed"
                        : "overflow-hidden whitespace-nowrap leading-snug",
                    )}
                  >
                    {isSel
                      ? "drafting — premise sweep done, draft v2 in session · advance_node awaits your approval"
                      : "drafting — awaiting you"}
                  </p>
                </button>
              ) : (
                <GateNode
                  node={n}
                  selected={isSel}
                  fresh={freshId === n.id}
                  expanded={isSel}
                  onOpen={onNode ? () => clickNode(n.id) : undefined}
                />
              )}
            </div>
          );
        })}

        <div
          className={cn(
            "absolute w-44 -translate-x-1/2 transition-opacity duration-200",
            selected === "gate" ? "z-20" : selected && "opacity-65",
          )}
          style={{
            left: px(0.5),
            top: gateRow * ROW_PX,
            height: selected === "gate" ? undefined : NODE_PX,
          }}
        >
          {onNode && gateState === "open" ? (
            <button
              type="button"
              onClick={() => clickNode("gate")}
              className={cn(
                "flex w-full min-w-0 flex-col rounded-xl border bg-card p-2.5 text-left transition-colors hover:border-foreground/40",
                selected === "gate"
                  ? "border-foreground/50 shadow-md"
                  : "h-full overflow-hidden border-foreground/25",
              )}
            >
              <div className="flex items-start gap-2">
                <LockOpenIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                  Readiness gate
                </span>
              </div>
              <p
                className={cn(
                  "mt-1 font-mono text-[9px] text-muted-foreground/60",
                  selected === "gate"
                    ? "leading-relaxed"
                    : "overflow-hidden whitespace-nowrap leading-snug",
                )}
              >
                {gateSub}
              </p>
            </button>
          ) : (
            <div
              className={cn(
                "flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card p-2.5",
                gateState === "sealed" ? "border-border" : "border-foreground/25",
              )}
            >
              <div className="flex items-start gap-2">
                {gateState === "sealed" ? (
                  <LockIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
                ) : (
                  <LockOpenIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                  Readiness gate
                </span>
              </div>
              <p className="mt-1 overflow-hidden whitespace-nowrap font-mono text-[9px] leading-snug text-muted-foreground/60">
                {gateSub}
              </p>
            </div>
          )}
        </div>
      </div>

      <span className="pointer-events-none absolute bottom-2 right-3 font-mono text-[9px] text-muted-foreground/40">
        drag to pan · scroll to zoom · click a node to enter it
      </span>
    </div>
  );
}

// The open gate's summary: unprovables first (promise 1), then the diff and
// the estimate — everything the verdict needs, before any spend.
export function GateSummary({ plan }: { plan: PlanPreview }) {
  return (
    <div className="space-y-1">
      {GATE.unprovables.map((u) => (
        <p
          key={u}
          className="flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground"
        >
          <FlagIcon className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
          {u}
        </p>
      ))}
      <p className="font-mono text-[10px] text-muted-foreground/60">{GATE.diffLine}</p>
      <p className="font-mono text-[10px] text-muted-foreground/60">
        {plan.line} · {plan.estimate}
      </p>
    </div>
  );
}

export type GateVerdict = "open" | "accepted" | "denied";

// The three verdicts + the degraded-mode acknowledgment Accept requires.
export function GateControls({
  verdict,
  onVerdict,
  modify,
  onModify,
  compact,
}: {
  verdict: GateVerdict;
  onVerdict: (v: GateVerdict) => void;
  modify: boolean;
  onModify: () => void;
  compact?: boolean;
}) {
  const [acked, setAcked] = useState(false);

  if (verdict === "accepted") {
    return (
      <div className="flex items-start gap-2">
        <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {GATE.acceptedLine}
        </p>
      </div>
    );
  }
  if (verdict === "denied") {
    return (
      <div className="flex items-start gap-2">
        <LockIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {GATE.deniedLine}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={acked}
          onChange={(e) => setAcked(e.target.checked)}
          className="mt-0.5 size-3 accent-foreground"
        />
        <span className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          {GATE.ack}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!acked}
          onClick={() => onVerdict("accepted")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
            acked
              ? "border-foreground/40 text-foreground hover:bg-muted/40"
              : "cursor-not-allowed border-border text-muted-foreground/50",
          )}
        >
          <CircleCheckIcon className="size-3" />
          Accept
        </button>
        <button
          type="button"
          onClick={onModify}
          className={cn(
            "rounded-lg border px-3 py-1.5 text-xs transition-colors",
            modify
              ? "border-foreground/40 font-medium text-foreground"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {modify ? "Modifying — done" : "Modify on the go"}
        </button>
        <button
          type="button"
          onClick={() => onVerdict("denied")}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Deny → straight to dev
        </button>
      </div>
    </div>
  );
}
