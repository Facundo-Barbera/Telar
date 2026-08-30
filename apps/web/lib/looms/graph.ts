import type { Loom, LoomEvent } from "./store";

/**
 * THE BRAID — the loom's history in its TRUE topology.
 *
 * The first graph drew orthogonal role-lanes and connected events that merely
 * shared a column; layout pretending to be causality, with no path to
 * follow. But a loom's history mostly IS a path: one narrative spine —
 * origin → proposal → gate → decisions → seen → accept — that genuinely
 * branches exactly once (the gate fans out into thread strands) and merges
 * exactly once (verified strands feed the accept). So that is what we draw:
 *
 *   SPINE    every loom-level moment, in order. Reading down = the story.
 *            Human moments are STATIONS (the moat as marked stops).
 *   STRANDS  one per thread, existing only from its spawn to its merge —
 *            carrying spawns, greens, reds, nudge deliveries.
 *   ARROWS   the few true cross-links: a nudge decision into its strand.
 *
 * Rows are global chronological order; a strand with no history yet simply
 * does not exist on screen (named in `quietStrands` instead).
 */

export type BraidTone = "info" | "verify" | "success" | "destructive" | "warning" | "muted" | "foreground";

export interface BraidNode {
  id: string;
  at: number;
  /** Global chronological row — the y axis for spine and strands alike. */
  row: number;
  kind: string;
  label: string;
  detail?: string;
  tone: BraidTone;
  /** A human station: drawn as a marked stop. The accept moat, visible. */
  station?: boolean;
  sessionId?: string;
}

export interface BraidStrand {
  slug: string;
  title: string;
  tier?: string;
  nodes: BraidNode[];
  /** True when this strand's latest verification is green AND the loom was
   *  accepted — the strand visually merges back into the spine. */
  mergesIntoAccept: boolean;
}

export interface BraidArrow {
  from: string;
  to: string;
  tone: "verify" | "warning";
}

export interface LoomBraid {
  spine: BraidNode[];
  strands: BraidStrand[];
  arrows: BraidArrow[];
  rows: number;
  quietStrands: string[];
}

const CAUSE_WINDOW_MS = 30 * 60_000;

export function deriveGraph(loom: Loom, events: LoomEvent[]): LoomBraid {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let counter = 0;
  const spine: BraidNode[] = [];
  const strandNodes = new Map<string, BraidNode[]>();
  const arrows: BraidArrow[] = [];

  const slugOf = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const thread = loom.threads.find((t) => t.slug === raw || t.title === raw);
    return thread ? thread.slug : null;
  };
  const make = (node: Omit<BraidNode, "id" | "row">): BraidNode => ({ ...node, id: `n${counter++}`, row: 0 });
  const toSpine = (node: Omit<BraidNode, "id" | "row">): BraidNode => {
    const full = make(node);
    spine.push(full);
    return full;
  };
  const toStrand = (slug: string, node: Omit<BraidNode, "id" | "row">): BraidNode => {
    const full = make(node);
    if (!strandNodes.has(slug)) strandNodes.set(slug, []);
    strandNodes.get(slug)!.push(full);
    return full;
  };

  toSpine({
    at: loom.createdAt,
    kind: "origin",
    label: loom.originSessionId ? "the conversation" : "created",
    detail: loom.objective,
    tone: "foreground",
    station: true,
    ...(loom.originSessionId ? { sessionId: loom.originSessionId } : {}),
  });

  let pendingEscalation: BraidNode | null = null;
  const pendingNudges: Array<{ node: BraidNode; slug: string; at: number }> = [];

  for (const event of sorted) {
    const slug = slugOf(event.thread);
    switch (event.kind) {
      case "proposal":
        toSpine({ at: event.at, kind: event.kind, label: "weaver proposed", detail: event.detail, tone: "verify" });
        break;
      case "gate":
        toSpine({ at: event.at, kind: event.kind, label: "you approved", detail: event.detail, tone: "success", station: true });
        break;
      case "spawn":
        if (slug) {
          toStrand(slug, {
            at: event.at,
            kind: event.kind,
            label: "spawned",
            detail: event.detail,
            tone: "info",
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          });
        }
        break;
      case "verify":
        if (slug) {
          toStrand(slug, {
            at: event.at,
            kind: event.kind,
            label: `${event.ok ? "green" : "red"}${event.commit ? ` @ ${event.commit.slice(0, 7)}` : ""}`,
            detail: event.detail,
            tone: event.ok ? "success" : "destructive",
          });
        }
        break;
      case "decision": {
        const node = toSpine({
          at: event.at,
          kind: event.kind,
          label: `conductor: ${event.move ?? "decided"}`,
          detail: event.detail,
          tone: "verify",
          ...(loom.conductorSessionId ? { sessionId: loom.conductorSessionId } : {}),
        });
        if (event.move === "nudge" && slug) pendingNudges.push({ node, slug, at: event.at });
        break;
      }
      case "nudge-delivered":
        if (slug) {
          const node = toStrand(slug, {
            at: event.at,
            kind: event.kind,
            label: "nudged",
            detail: event.detail,
            tone: "verify",
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          });
          const source = pendingNudges.find((n) => n.slug === slug && event.at - n.at < CAUSE_WINDOW_MS);
          if (source) arrows.push({ from: source.node.id, to: node.id, tone: "verify" });
        }
        break;
      case "escalation":
        pendingEscalation = toSpine({
          at: event.at,
          kind: event.kind,
          label: "conductor escalated",
          detail: event.detail,
          tone: "warning",
          ...(loom.conductorSessionId ? { sessionId: loom.conductorSessionId } : {}),
        });
        break;
      case "seen": {
        toSpine({ at: event.at, kind: event.kind, label: "you saw it", detail: event.detail, tone: "foreground", station: true });
        pendingEscalation = null;
        break;
      }
      case "conductor-born":
        toSpine({
          at: event.at,
          kind: event.kind,
          label: "conductor born",
          detail: event.detail,
          tone: "muted",
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
        break;
      default:
        toSpine({ at: event.at, kind: "note", label: event.detail.slice(0, 36), detail: event.detail, tone: "muted" });
    }
  }

  if (loom.attention && pendingEscalation) {
    toSpine({ at: pendingEscalation.at + 1, kind: "attention", label: "awaiting you", detail: loom.attention, tone: "warning", station: true });
  }
  if (loom.acceptedAt) {
    toSpine({ at: loom.acceptedAt, kind: "accept", label: "you accepted", tone: "success", station: true });
  }

  // Global chronological rows: one clock for spine and strands, so the story
  // reads straight down no matter which side of the braid an event landed on.
  const all = [...spine, ...[...strandNodes.values()].flat()].sort((a, b) => a.at - b.at);
  all.forEach((node, index) => {
    node.row = index;
  });
  spine.sort((a, b) => a.row - b.row);

  const strands: BraidStrand[] = [];
  const quietStrands: string[] = [];
  for (const thread of loom.threads) {
    const nodes = (strandNodes.get(thread.slug) ?? []).sort((a, b) => a.row - b.row);
    if (nodes.length === 0) {
      quietStrands.push(thread.title);
      continue;
    }
    const lastVerify = [...nodes].reverse().find((n) => n.kind === "verify");
    strands.push({
      slug: thread.slug,
      title: thread.title,
      ...(thread.tier ? { tier: thread.tier } : {}),
      nodes,
      mergesIntoAccept: Boolean(loom.acceptedAt && lastVerify?.tone === "success"),
    });
  }

  return { spine, strands, arrows, rows: all.length, quietStrands };
}
