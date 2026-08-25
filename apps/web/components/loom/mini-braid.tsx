"use client";

/**
 * THE BRAID, AT RAIL SCALE — the loom's history as a compact strip in the
 * room's member rail, where a glance answers "what has happened here" without
 * a page of its own. Same derivation as the full braid (/api/looms/:id/graph),
 * drawn without labels: dots on a spine, strand ticks beside it, ringed stops
 * where a human acted. Hover names a stop; clicking one selects the member it
 * belongs to, so the braid is the room's own scrubber rather than a separate
 * exhibit that says a lot of nothing.
 */
import { useCallback, useEffect, useState } from "react";
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
  nodes: BraidNode[];
  mergesIntoAccept: boolean;
}

interface BraidData {
  spine: BraidNode[];
  strands: BraidStrand[];
  rows: number;
}

const FILL: Record<BraidNode["tone"], string> = {
  info: "fill-info",
  verify: "fill-verify",
  success: "fill-success",
  destructive: "fill-destructive",
  warning: "fill-warning",
  muted: "fill-muted-foreground",
  foreground: "fill-foreground",
};

const ROW_H = 16;
const SPINE_X = 14;
const STRAND_START = 34;
const STRAND_GAP = 18;

export function MiniBraid({
  loomId,
  onPick,
}: {
  loomId: string;
  /** A stop was clicked: hand the room the session it belongs to (or none,
   *  for a loom-level moment) and let the room translate it to a selection. */
  onPick: (node: { sessionId?: string; threadSlug?: string }) => void;
}) {
  const [braid, setBraid] = useState<BraidData | null>(null);
  const [hovered, setHovered] = useState<BraidNode | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/looms/${loomId}/graph`);
      if (r.ok) setBraid(await r.json());
    } catch {
      // The rail keeps its last picture rather than blanking.
    }
  }, [loomId]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [refresh]);

  if (!braid || (braid.spine.length <= 1 && braid.strands.length === 0)) return null;

  const y = (row: number) => 8 + row * ROW_H;
  const height = 8 + Math.max(braid.rows, 1) * ROW_H + 12;
  const lastSpine = braid.spine.at(-1);
  const gate = braid.spine.find((n) => n.kind === "gate");
  const accept = braid.spine.find((n) => n.kind === "accept");

  const dot = (node: BraidNode, x: number, strandSlug?: string) => (
    <g
      key={node.id}
      className="cursor-pointer"
      onMouseEnter={() => setHovered(node)}
      onMouseLeave={() => setHovered((h) => (h?.id === node.id ? null : h))}
      onClick={() => onPick({ ...(node.sessionId ? { sessionId: node.sessionId } : {}), ...(strandSlug ? { threadSlug: strandSlug } : {}) })}
    >
      {node.station ? <circle cx={x} cy={y(node.row)} r={5.5} fill="none" strokeWidth={1.2} className="stroke-foreground/60" /> : null}
      <circle cx={x} cy={y(node.row)} r={3} className={FILL[node.tone]} />
      <title>{`${fmtAgo(node.at)} · ${node.detail ?? node.label}`}</title>
    </g>
  );

  return (
    <div>
      <div className="max-h-56 overflow-y-auto">
        <svg width="100%" height={height} viewBox={`0 0 ${STRAND_START + braid.strands.length * STRAND_GAP + 8} ${height}`} role="img" aria-label="Loom history">
          {braid.spine.length > 1 && lastSpine ? (
            <line x1={SPINE_X} x2={SPINE_X} y1={y(braid.spine[0].row)} y2={y(lastSpine.row)} strokeWidth={1.5} className="stroke-foreground/25" />
          ) : null}
          {!accept && lastSpine ? (
            <line
              x1={SPINE_X}
              x2={SPINE_X}
              y1={y(lastSpine.row)}
              y2={y(lastSpine.row) + ROW_H}
              strokeWidth={1.5}
              strokeDasharray="2 4"
              className="stroke-foreground/20"
            />
          ) : null}
          {braid.strands.map((strand, index) => {
            const x = STRAND_START + index * STRAND_GAP;
            const first = strand.nodes[0];
            const last = strand.nodes.at(-1)!;
            const branchY = gate ? y(gate.row) : y(first.row) - ROW_H;
            const parts = [
              `M ${SPINE_X} ${branchY} C ${SPINE_X} ${branchY + 10}, ${x} ${y(first.row) - 10}, ${x} ${y(first.row)}`,
              `L ${x} ${y(last.row)}`,
            ];
            if (strand.mergesIntoAccept && accept) {
              parts.push(`C ${x} ${y(last.row) + 10}, ${SPINE_X} ${y(accept.row) - 10}, ${SPINE_X} ${y(accept.row)}`);
            }
            return (
              <g key={strand.slug}>
                <path d={parts.join(" ")} fill="none" strokeWidth={1} className="stroke-info/40" />
                {strand.nodes.map((node) => dot(node, x, strand.slug))}
              </g>
            );
          })}
          {braid.spine.map((node) => dot(node, SPINE_X))}
        </svg>
      </div>
      <p className="min-h-8 px-1 pt-1 text-[10px] leading-4 text-muted-foreground">
        {hovered ? `${fmtAgo(hovered.at)} · ${hovered.label}` : "The story so far — click a stop to open it."}
      </p>
    </div>
  );
}
