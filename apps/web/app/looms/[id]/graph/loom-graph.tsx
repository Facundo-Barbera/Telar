"use client";

/**
 * THE CAUSALITY GRAPH, RENDERED — a hand-rolled SVG lane graph, in the git-log
 * tradition rather than a physics library's: lanes are ROLES (You, Conductor,
 * Machine, one per thread), time flows down, and every cross-lane edge is a
 * cause the machine is certain of. The human lane holding only approvals,
 * "seen"s and the final accept is the accept moat drawn as geometry.
 *
 * Useful before creative: hovering any node shows its full detail in the
 * inspector bar; clicking a node with a session behind it enters that session
 * inside the loom. The graph IS navigation, not an illustration.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtAgo } from "@/lib/format";

interface GraphLane {
  id: string;
  label: string;
  kind: "human" | "conductor" | "machine" | "thread";
  tier?: string;
}

interface GraphNode {
  id: string;
  lane: string;
  at: number;
  kind: string;
  label: string;
  detail?: string;
  tone: "info" | "verify" | "success" | "destructive" | "warning" | "muted" | "foreground";
  sessionId?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  tone: "muted" | "verify" | "warning" | "success";
}

interface LoomGraphData {
  loomId: string;
  title: string;
  lanes: GraphLane[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const LANE_W = 172;
const GUTTER_W = 64;
const ROW_H = 44;
const TOP_PAD = 16;

const NODE_FILL: Record<GraphNode["tone"], string> = {
  info: "fill-info",
  verify: "fill-verify",
  success: "fill-success",
  destructive: "fill-destructive",
  warning: "fill-warning",
  muted: "fill-muted-foreground",
  foreground: "fill-foreground",
};

const EDGE_STROKE: Record<GraphEdge["tone"], string> = {
  muted: "stroke-border",
  verify: "stroke-verify/60",
  warning: "stroke-warning/70",
  success: "stroke-success/60",
};

export function LoomGraph({ loomId }: { loomId: string }) {
  const router = useRouter();
  const [graph, setGraph] = useState<LoomGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/looms/${loomId}/graph`);
      if (!r.ok) throw new Error(`graph: ${r.status}`);
      setGraph(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [loomId]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  const laneX = useCallback(
    (laneId: string) => {
      const index = graph?.lanes.findIndex((l) => l.id === laneId) ?? 0;
      return GUTTER_W + index * LANE_W + 24;
    },
    [graph],
  );

  // Rows are CHRONOLOGICAL ORDER, not wall-clock distance: a loom sleeps for
  // hours between bursts, and clock-proportional spacing would be one dense
  // knot and a mile of nothing. The gutter carries the real times.
  const ordered = graph ? [...graph.nodes].sort((a, b) => a.at - b.at) : [];
  const rowOf = new Map(ordered.map((n, i) => [n.id, i]));
  const nodeY = (id: string) => TOP_PAD + (rowOf.get(id) ?? 0) * ROW_H + 20;

  const width = graph ? GUTTER_W + graph.lanes.length * LANE_W + 24 : 640;
  const height = TOP_PAD + Math.max(ordered.length, 1) * ROW_H + 32;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={
          <Button variant="ghost" size="icon-sm" aria-label="Back to the loom" render={<Link href={`/looms/${loomId}`} />}>
            <ArrowLeftIcon />
          </Button>
        }
        title={graph ? `${graph.title} — graph` : "Graph"}
        description="Every decision and conversation, as causality. Hover for detail; click a node to enter its session."
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          </div>
        ) : null}
        {graph === null && !error ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-8 w-2/3 rounded-md" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : null}

        {graph ? (
          <div style={{ width, minWidth: "100%" }}>
            {/* Lane headers: sticky against vertical scroll, scrolled with the
                lanes horizontally because they share this container. */}
            <div className="sticky top-0 z-10 flex border-b border-border/60 bg-background/95 backdrop-blur" style={{ width }}>
              <div style={{ width: GUTTER_W }} />
              {graph.lanes.map((lane) => (
                <div key={lane.id} className="flex items-baseline gap-1.5 px-2 py-2" style={{ width: LANE_W }}>
                  <span
                    className={`truncate text-xs font-medium ${
                      lane.kind === "human" ? "text-foreground" : lane.kind === "conductor" ? "text-verify" : "text-muted-foreground"
                    }`}
                  >
                    {lane.label}
                  </span>
                  {lane.tier ? <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground">{lane.tier}</span> : null}
                </div>
              ))}
            </div>

            <svg width={width} height={height} role="img" aria-label="Loom causality graph">
              {/* Lane guides */}
              {graph.lanes.map((lane) => (
                <line
                  key={lane.id}
                  x1={laneX(lane.id)}
                  x2={laneX(lane.id)}
                  y1={0}
                  y2={height}
                  className={lane.kind === "human" ? "stroke-border" : "stroke-border/50"}
                  strokeDasharray={lane.kind === "thread" ? "2 4" : undefined}
                />
              ))}

              {/* Edges under nodes. Same-lane spines are straight; cross-lane
                  causes curve, so a cause READS as a hand-off. */}
              {graph.edges.map((edge, i) => {
                const from = graph.nodes.find((n) => n.id === edge.from);
                const to = graph.nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;
                const x1 = laneX(from.lane);
                const y1 = nodeY(from.id);
                const x2 = laneX(to.lane);
                const y2 = nodeY(to.id);
                const d =
                  x1 === x2
                    ? `M ${x1} ${y1} L ${x2} ${y2}`
                    : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
                return <path key={i} d={d} fill="none" strokeWidth={1.5} className={EDGE_STROKE[edge.tone]} />;
              })}

              {/* Time gutter: the real clock, deduplicated. */}
              {ordered.map((node, i) => {
                const label = fmtAgo(node.at);
                const previous = i > 0 ? fmtAgo(ordered[i - 1].at) : null;
                if (label === previous) return null;
                return (
                  <text key={`t-${node.id}`} x={8} y={nodeY(node.id) + 3} className="fill-muted-foreground text-[9px] tabular-nums">
                    {label}
                  </text>
                );
              })}

              {/* Nodes */}
              {graph.nodes.map((node) => {
                const x = laneX(node.lane);
                const y = nodeY(node.id);
                const clickable = Boolean(node.sessionId);
                return (
                  <g
                    key={node.id}
                    className={clickable ? "cursor-pointer" : undefined}
                    onMouseEnter={() => setHovered(node)}
                    onMouseLeave={() => setHovered((h) => (h?.id === node.id ? null : h))}
                    onClick={clickable ? () => router.push(`/looms/${loomId}/threads/${node.sessionId}`) : undefined}
                  >
                    <circle cx={x} cy={y} r={hovered?.id === node.id ? 6 : 4.5} className={NODE_FILL[node.tone]} />
                    {clickable ? <circle cx={x} cy={y} r={9} fill="none" strokeWidth={1} className="stroke-border" /> : null}
                    <text x={x + 14} y={y + 3.5} className="fill-foreground/85 text-[10px]">
                      {node.label.length > 20 ? `${node.label.slice(0, 20)}…` : node.label}
                    </text>
                    <title>{node.detail ?? node.label}</title>
                  </g>
                );
              })}
            </svg>
          </div>
        ) : null}
      </div>

      {/* The inspector bar: the hovered node's whole sentence, without leaving
          the graph. Reserved height so the graph never jumps. */}
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border/60 bg-muted/20 px-4 text-xs">
        {hovered ? (
          <>
            <span className={`size-2 shrink-0 rounded-full ${NODE_FILL[hovered.tone].replace("fill-", "bg-")}`} />
            <span className="shrink-0 font-mono text-muted-foreground">{fmtAgo(hovered.at)}</span>
            <span className="min-w-0 truncate text-foreground/90">{hovered.detail ?? hovered.label}</span>
            {hovered.sessionId ? <span className="ml-auto shrink-0 text-muted-foreground">click to open →</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">Hover a node to inspect it.</span>
        )}
      </div>
    </div>
  );
}
