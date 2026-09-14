"use client";

/**
 * THE BRAID, RENDERED — one spine you read top to bottom (the story), thread
 * strands that branch off at their spawn and rejoin at accept (the one
 * honestly parallel stretch), and the rare true cross-link drawn as an arrow.
 * Human moments are STATIONS — ringed stops on the spine — which is where
 * the accept moat lives visually now: the story only ever passes through a
 * human at a station.
 *
 * Hover inspects in the bottom bar; click enters the session behind a node.
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

interface BraidNode {
  id: string;
  at: number;
  row: number;
  kind: string;
  label: string;
  detail?: string;
  tone: "info" | "verify" | "success" | "destructive" | "warning" | "muted" | "foreground";
  station?: boolean;
  sessionId?: string;
}

interface BraidStrand {
  slug: string;
  title: string;
  tier?: string;
  nodes: BraidNode[];
  mergesIntoAccept: boolean;
}

interface LoomBraidData {
  loomId: string;
  title: string;
  spine: BraidNode[];
  strands: BraidStrand[];
  arrows: Array<{ from: string; to: string; tone: "verify" | "warning" }>;
  rows: number;
  quietStrands: string[];
}

const ROW_H = 42;
const TOP_PAD = 24;
const TIME_W = 64;
const SPINE_X = TIME_W + 236;
const STRAND_START = SPINE_X + 96;
const STRAND_GAP = 108;

const FILL: Record<BraidNode["tone"], string> = {
  info: "fill-info",
  verify: "fill-verify",
  success: "fill-success",
  destructive: "fill-destructive",
  warning: "fill-warning",
  muted: "fill-muted-foreground",
  foreground: "fill-foreground",
};

export function LoomGraph({ loomId }: { loomId: string }) {
  const router = useRouter();
  const [braid, setBraid] = useState<LoomBraidData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<BraidNode | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/looms/${loomId}/graph`);
      if (!r.ok) throw new Error(`graph: ${r.status}`);
      setBraid(await r.json());
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

  const y = (row: number) => TOP_PAD + row * ROW_H + 16;
  const strandX = (index: number) => STRAND_START + index * STRAND_GAP;
  const nodeById = (id: string) => braid?.spine.find((n) => n.id === id) ?? braid?.strands.flatMap((s) => s.nodes).find((n) => n.id === id);
  const strandOf = (id: string) => braid?.strands.findIndex((s) => s.nodes.some((n) => n.id === id)) ?? -1;
  const xOf = (node: BraidNode) => {
    const index = strandOf(node.id);
    return index >= 0 ? strandX(index) : SPINE_X;
  };

  const width = braid ? Math.max(STRAND_START + braid.strands.length * STRAND_GAP + 48, 720) : 720;
  const height = braid ? TOP_PAD + Math.max(braid.rows, 1) * ROW_H + 48 : 400;
  const gate = braid?.spine.find((n) => n.kind === "gate");
  const accept = braid?.spine.find((n) => n.kind === "accept");
  const lastSpine = braid?.spine.at(-1);

  const renderNode = (node: BraidNode, x: number, labelSide: "left" | "right", emphasis?: boolean) => {
    const clickable = Boolean(node.sessionId);
    const cy = y(node.row);
    return (
      <g
        key={node.id}
        className={clickable ? "cursor-pointer" : undefined}
        onMouseEnter={() => setHovered(node)}
        onMouseLeave={() => setHovered((h) => (h?.id === node.id ? null : h))}
        onClick={clickable ? () => router.push(`/looms/${loomId}/threads/${node.sessionId}`) : undefined}
      >
        {node.station ? <circle cx={x} cy={cy} r={9} fill="none" strokeWidth={1.5} className="stroke-foreground/60" /> : null}
        <circle cx={x} cy={cy} r={hovered?.id === node.id ? 6 : 4.5} className={FILL[node.tone]} />
        <text
          x={labelSide === "left" ? x - 16 : x + 14}
          y={cy + 3.5}
          textAnchor={labelSide === "left" ? "end" : "start"}
          className={`text-3xs ${emphasis ? "fill-foreground font-medium" : "fill-foreground/80"}`}
        >
          {node.label.length > 26 ? `${node.label.slice(0, 26)}…` : node.label}
        </text>
        <title>{node.detail ?? node.label}</title>
      </g>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        leading={
          <Button variant="ghost" size="icon-sm" aria-label="Back to the loom" render={<Link href={`/looms/${loomId}`} />}>
            <ArrowLeftIcon />
          </Button>
        }
        title={braid ? `${braid.title} — the braid` : "The braid"}
        description="Read down the spine: that is the story. Strands are the threads, branching at your gate and merging at your accept. Ringed stops are you."
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          </div>
        ) : null}
        {braid === null && !error ? (
          <div className="space-y-3 p-6">
            <Skeleton className="h-8 w-2/3 rounded-md" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : null}

        {braid ? (
          <div style={{ width, minWidth: "100%" }}>
            <svg width={width} height={height} role="img" aria-label="Loom braid">
              {/* THE SPINE: one continuous line from the first moment to the
                  last — the path to follow. */}
              {braid.spine.length > 1 ? (
                <line
                  x1={SPINE_X}
                  x2={SPINE_X}
                  y1={y(braid.spine[0].row)}
                  y2={y(lastSpine!.row)}
                  strokeWidth={2}
                  className="stroke-foreground/25"
                />
              ) : null}
              {/* Still alive: the spine trails onward past its last moment. */}
              {!accept && lastSpine ? (
                <line
                  x1={SPINE_X}
                  x2={SPINE_X}
                  y1={y(lastSpine.row)}
                  y2={y(lastSpine.row) + ROW_H}
                  strokeWidth={2}
                  strokeDasharray="2 5"
                  className="stroke-foreground/20"
                />
              ) : null}

              {/* STRANDS: branch from the gate (or their first event), run
                  through their own history, and either merge into accept or
                  trail open — still working. */}
              {braid.strands.map((strand, index) => {
                const x = strandX(index);
                const first = strand.nodes[0];
                const last = strand.nodes.at(-1)!;
                const branchY = gate ? y(gate.row) : y(first.row) - ROW_H;
                const parts: string[] = [
                  `M ${SPINE_X} ${branchY} C ${SPINE_X} ${branchY + 24}, ${x} ${y(first.row) - 24}, ${x} ${y(first.row)}`,
                  `L ${x} ${y(last.row)}`,
                ];
                if (strand.mergesIntoAccept && accept) {
                  parts.push(`C ${x} ${y(last.row) + 24}, ${SPINE_X} ${y(accept.row) - 24}, ${SPINE_X} ${y(accept.row)}`);
                }
                return (
                  <g key={strand.slug}>
                    <path d={parts.join(" ")} fill="none" strokeWidth={1.5} className="stroke-info/40" />
                    {!strand.mergesIntoAccept ? (
                      <line
                        x1={x}
                        x2={x}
                        y1={y(last.row)}
                        y2={y(last.row) + ROW_H * 0.8}
                        strokeWidth={1.5}
                        strokeDasharray="2 5"
                        className="stroke-info/30"
                      />
                    ) : null}
                    {/* The strand's name, at its birth. */}
                    <text x={x + 14} y={y(first.row) - 14} className="fill-muted-foreground text-3xs font-medium">
                      {strand.title.length > 24 ? `${strand.title.slice(0, 24)}…` : strand.title}
                      {strand.tier ? `  · ${strand.tier}` : ""}
                    </text>
                  </g>
                );
              })}

              {/* ARROWS: the few true cross-links (a nudge into its strand). */}
              {braid.arrows.map((arrow, i) => {
                const from = nodeById(arrow.from);
                const to = nodeById(arrow.to);
                if (!from || !to) return null;
                const x1 = xOf(from);
                const y1 = y(from.row);
                const x2 = xOf(to);
                const y2 = y(to.row);
                return (
                  <path
                    key={`a${i}`}
                    d={`M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2 - 8} ${y2}`}
                    fill="none"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    className={arrow.tone === "verify" ? "stroke-verify/70" : "stroke-warning/70"}
                  />
                );
              })}

              {/* Time gutter, deduplicated. */}
              {[...braid.spine, ...braid.strands.flatMap((s) => s.nodes)]
                .sort((a, b) => a.row - b.row)
                .map((node, i, all) => {
                  const label = fmtAgo(node.at);
                  if (i > 0 && fmtAgo(all[i - 1].at) === label) return null;
                  return (
                    <text key={`t-${node.id}`} x={8} y={y(node.row) + 3} className="fill-muted-foreground text-4xs tabular-nums">
                      {label}
                    </text>
                  );
                })}

              {braid.spine.map((node) => renderNode(node, SPINE_X, "left", node.station))}
              {braid.strands.map((strand, index) => strand.nodes.map((node) => renderNode(node, strandX(index), "right")))}
            </svg>

            {braid.quietStrands.length > 0 ? (
              <p className="px-4 pb-4 text-xs text-muted-foreground">
                Not yet part of the story: {braid.quietStrands.join(" · ")} — each joins the braid at its first event.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-9 shrink-0 items-center gap-2 border-t border-border/60 bg-muted/20 px-4 text-xs">
        {hovered ? (
          <>
            <span className={`size-2 shrink-0 rounded-full ${FILL[hovered.tone].replace("fill-", "bg-")}`} />
            <span className="shrink-0 font-mono text-muted-foreground">{fmtAgo(hovered.at)}</span>
            <span className="min-w-0 truncate text-foreground/90">{hovered.detail ?? hovered.label}</span>
            {hovered.sessionId ? <span className="ml-auto shrink-0 text-muted-foreground">click to open →</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">Hover a stop to inspect it.</span>
        )}
      </div>
    </div>
  );
}
