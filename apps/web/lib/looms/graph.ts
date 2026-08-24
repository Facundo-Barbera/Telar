import type { Loom, LoomEvent } from "./store";

/**
 * THE CAUSALITY GRAPH — the loom's history as the DAG it always was.
 *
 * Derived, never stored: nodes come from the typed event log (plus the loom
 * record's own facts), edges only where causality is CERTAIN — a gate spawned
 * these threads, this nudge went to that thread, this escalation was seen by
 * the human. No inferred "probably caused" edges: a graph that guesses is a
 * story, and this surface exists to be evidence.
 *
 * LANES ARE ROLES, and that is the point of the layout: the human lane
 * containing only gate-clears, steering, "seen"s and the final accept is the
 * accept moat drawn as geometry.
 */

export type GraphTone = "info" | "verify" | "success" | "destructive" | "warning" | "muted" | "foreground";

export interface GraphLane {
  id: string;
  label: string;
  kind: "human" | "conductor" | "machine" | "thread";
  tier?: string;
}

export interface GraphNode {
  id: string;
  lane: string;
  at: number;
  kind: string;
  label: string;
  detail?: string;
  tone: GraphTone;
  /** Where clicking lands — a session inside the loom, when there is one. */
  sessionId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  tone: "muted" | "verify" | "warning" | "success";
}

export interface LoomGraph {
  lanes: GraphLane[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Lanes with no history yet, named so the UI can say they exist without
   *  spending a column of nothing on each. */
  quietLanes: string[];
}

const NUDGE_WINDOW_MS = 30 * 60_000;

export function deriveGraph(loom: Loom, events: LoomEvent[]): LoomGraph {
  const lanes: GraphLane[] = [
    { id: "human", label: "You", kind: "human" },
    { id: "conductor", label: "Conductor", kind: "conductor" },
    { id: "machine", label: "Machine", kind: "machine" },
    ...loom.threads.map((t) => ({
      id: `thread:${t.slug}`,
      label: t.title,
      kind: "thread" as const,
      ...(t.tier ? { tier: t.tier } : {}),
    })),
  ];
  const threadLane = (slug: string | undefined): string | null => {
    if (!slug) return null;
    return loom.threads.some((t) => t.slug === slug || t.title === slug) ? `thread:${loom.threads.find((t) => t.slug === slug || t.title === slug)!.slug}` : null;
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let counter = 0;
  const push = (node: Omit<GraphNode, "id">): GraphNode => {
    const full = { ...node, id: `n${counter++}` };
    nodes.push(full);
    return full;
  };

  // The root is the loom's own birth; the origin conversation, when there is
  // one, is what it grew from.
  const root = push({
    lane: loom.originSessionId ? "human" : "machine",
    at: loom.createdAt,
    kind: "origin",
    label: loom.originSessionId ? "conversation" : "created",
    tone: "foreground",
    ...(loom.originSessionId ? { sessionId: loom.originSessionId } : {}),
  });

  const sorted = [...events].sort((a, b) => a.at - b.at);
  let lastGate: GraphNode | null = null;
  let lastEscalation: GraphNode | null = null;
  const pendingNudges: Array<{ node: GraphNode; thread: string; at: number }> = [];
  const pendingVerifyDecisions: GraphNode[] = [];
  const latestGreenByThread = new Map<string, GraphNode>();
  let proposalNode: GraphNode | null = null;

  for (const event of sorted) {
    switch (event.kind) {
      case "proposal": {
        proposalNode = push({ lane: "machine", at: event.at, kind: event.kind, label: "weaver proposed", detail: event.detail, tone: "verify" });
        edges.push({ from: root.id, to: proposalNode.id, tone: "muted" });
        break;
      }
      case "gate": {
        lastGate = push({ lane: "human", at: event.at, kind: event.kind, label: "approved", detail: event.detail, tone: "success" });
        if (proposalNode) edges.push({ from: proposalNode.id, to: lastGate.id, tone: "muted" });
        break;
      }
      case "spawn": {
        const lane = threadLane(event.thread) ?? "machine";
        const node = push({
          lane,
          at: event.at,
          kind: event.kind,
          label: "spawned",
          detail: event.detail,
          tone: "info",
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
        if (lastGate) edges.push({ from: lastGate.id, to: node.id, tone: "success" });
        break;
      }
      case "verify": {
        const lane = threadLane(event.thread) ?? "machine";
        const node = push({
          lane,
          at: event.at,
          kind: event.kind,
          label: `${event.ok ? "green" : "red"}${event.commit ? ` @ ${event.commit.slice(0, 7)}` : ""}`,
          detail: event.detail,
          tone: event.ok ? "success" : "destructive",
        });
        const decision = pendingVerifyDecisions.at(-1);
        if (decision && event.at - decision.at < NUDGE_WINDOW_MS) edges.push({ from: decision.id, to: node.id, tone: "verify" });
        if (event.ok && event.thread) latestGreenByThread.set(event.thread, node);
        break;
      }
      case "decision": {
        const node = push({
          lane: "conductor",
          at: event.at,
          kind: event.kind,
          label: event.move ?? "decision",
          detail: event.detail,
          tone: "verify",
          ...(loom.conductorSessionId ? { sessionId: loom.conductorSessionId } : {}),
        });
        if (event.move === "verify") pendingVerifyDecisions.push(node);
        if (event.move === "nudge" && event.thread) pendingNudges.push({ node, thread: event.thread, at: event.at });
        break;
      }
      case "nudge-delivered": {
        const lane = threadLane(event.thread) ?? "conductor";
        const node = push({
          lane,
          at: event.at,
          kind: event.kind,
          label: "nudged",
          detail: event.detail,
          tone: "verify",
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
        const source = pendingNudges.find((n) => n.thread === event.thread && event.at - n.at < NUDGE_WINDOW_MS);
        if (source) edges.push({ from: source.node.id, to: node.id, tone: "verify" });
        break;
      }
      case "escalation": {
        lastEscalation = push({
          lane: "conductor",
          at: event.at,
          kind: event.kind,
          label: "escalated",
          detail: event.detail,
          tone: "warning",
          ...(loom.conductorSessionId ? { sessionId: loom.conductorSessionId } : {}),
        });
        break;
      }
      case "seen": {
        const node = push({ lane: "human", at: event.at, kind: event.kind, label: "seen", detail: event.detail, tone: "foreground" });
        if (lastEscalation) {
          edges.push({ from: lastEscalation.id, to: node.id, tone: "warning" });
          lastEscalation = null;
        }
        break;
      }
      case "conductor-born": {
        push({
          lane: "conductor",
          at: event.at,
          kind: event.kind,
          label: "conductor born",
          detail: event.detail,
          tone: "muted",
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
        break;
      }
      default: {
        const lane = event.actor === "human" ? "human" : event.actor === "conductor" ? "conductor" : threadLane(event.thread) ?? "machine";
        push({ lane, at: event.at, kind: "note", label: event.detail.slice(0, 32), detail: event.detail, tone: "muted" });
      }
    }
  }

  // The unresolved escalation is a live fact, not history: it points at you.
  if (loom.attention && lastEscalation) {
    const node = push({ lane: "human", at: Date.now(), kind: "attention", label: "awaiting you", detail: loom.attention, tone: "warning" });
    edges.push({ from: lastEscalation.id, to: node.id, tone: "warning" });
  }

  if (loom.acceptedAt) {
    const accept = push({ lane: "human", at: loom.acceptedAt, kind: "accept", label: "accepted", tone: "success" });
    for (const green of latestGreenByThread.values()) edges.push({ from: green.id, to: accept.id, tone: "success" });
  }

  // Lane spines: consecutive nodes in a lane, so every lane reads as a
  // timeline even where no cross-lane causality exists.
  for (const lane of lanes) {
    const inLane = nodes.filter((n) => n.lane === lane.id);
    for (let i = 1; i < inLane.length; i++) edges.push({ from: inLane[i - 1].id, to: inLane[i].id, tone: "muted" });
  }

  // A LANE IS EARNED BY HISTORY. Reserving a column per thread before
  // anything ever happened in it drew a graph that was mostly reserved
  // emptiness — the one real cause arcing across four blank columns read as
  // broken, not as sparse. Quiet lanes are named below the graph instead,
  // and each takes its column the moment its first event lands.
  const populated = new Set(nodes.map((n) => n.lane));
  const quietLanes = lanes.filter((lane) => !populated.has(lane.id)).map((lane) => lane.label);
  return { lanes: lanes.filter((lane) => populated.has(lane.id)), nodes, edges, quietLanes };
}
