/**
 * The causality graph's load-bearing facts: lanes are roles, edges exist only
 * where causality is certain, and old markdown-only journals are recoverable
 * into typed events.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveGraph } from "./graph";
import { appendEvent, loomDir, newLoom, readEvents, type Loom, type LoomEvent } from "./store";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-graph-"));
  previousHome = process.env.TELAR_HOME;
  process.env.TELAR_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function loom(): Loom {
  return newLoom({
    title: "L",
    objective: "x",
    projectId: "p",
    originSessionId: "session_origin",
    conductorSessionId: "session_conductor",
    threads: [
      { slug: "a", title: "A", brief: "...", sessionId: "session_a", tier: "unit" },
      { slug: "b", title: "B", brief: "...", sessionId: "session_b" },
    ],
  });
}

test("events round-trip through the jsonl, and the journal renders the same entry", () => {
  const l = loom();
  appendEvent(l.id, { actor: "machine", kind: "spawn", thread: "a", sessionId: "session_a", detail: "spawned thread a as session_a on x" });
  const events = readEvents(l.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: "spawn", thread: "a", sessionId: "session_a" });
  expect(fs.readFileSync(path.join(loomDir(l.id), "journal.md"), "utf8")).toContain("**machine**: spawned thread a");
});

test("a markdown-only journal is recovered into typed events", () => {
  const l = loom();
  fs.mkdirSync(loomDir(l.id), { recursive: true });
  fs.writeFileSync(
    path.join(loomDir(l.id), "journal.md"),
    [
      "- 2026-08-23T10:00:00.000Z **weaver**: proposed 2 threads (a, b)",
      "- 2026-08-23T10:01:00.000Z **human**: cleared the execute gate — spawning threads",
      "- 2026-08-23T10:02:00.000Z **machine**: spawned thread a as session_a on loom/l/a",
      "- 2026-08-23T10:03:00.000Z **machine**: verified a: unit green at abc1234",
      "- 2026-08-23T10:04:00.000Z **conductor**: nudge(b): it stalled",
      "- 2026-08-23T10:05:00.000Z **conductor**: escalate: needs a human",
      "- 2026-08-23T10:06:00.000Z **human**: something unstructured",
    ].join("\n"),
  );
  const kinds = readEvents(l.id).map((e) => e.kind);
  expect(kinds).toEqual(["proposal", "gate", "spawn", "verify", "decision", "escalation", "note"]);
  const verify = readEvents(l.id).find((e) => e.kind === "verify")!;
  expect(verify).toMatchObject({ thread: "a", ok: true, commit: "abc1234" });
});

test("lanes are roles, and certain causality becomes edges", () => {
  const l = loom();
  const t0 = Date.parse("2026-08-23T10:00:00Z");
  const events: LoomEvent[] = [
    { at: t0, actor: "weaver", kind: "proposal", detail: "proposed 2 threads" },
    { at: t0 + 1000, actor: "human", kind: "gate", detail: "cleared the execute gate" },
    { at: t0 + 2000, actor: "machine", kind: "spawn", thread: "a", sessionId: "session_a", detail: "spawned a" },
    { at: t0 + 3000, actor: "machine", kind: "spawn", thread: "b", sessionId: "session_b", detail: "spawned b" },
    { at: t0 + 4000, actor: "conductor", kind: "decision", move: "nudge", thread: "b", detail: "nudge(b): stalled" },
    { at: t0 + 5000, actor: "conductor", kind: "nudge-delivered", thread: "b", sessionId: "session_b", detail: "nudged b" },
    { at: t0 + 6000, actor: "conductor", kind: "escalation", detail: "escalate: help" },
    { at: t0 + 7000, actor: "human", kind: "seen", detail: "saw the escalation" },
  ];
  const graph = deriveGraph(l, events);

  expect(graph.lanes.map((lane) => lane.id)).toEqual(["human", "conductor", "machine", "thread:a", "thread:b"]);
  // The human lane holds only human acts — the moat as geometry.
  const humanNodes = graph.nodes.filter((n) => n.lane === "human");
  expect(humanNodes.map((n) => n.kind).sort()).toEqual(["gate", "origin", "seen"]);

  const byKind = (kind: string) => graph.nodes.filter((n) => n.kind === kind);
  const gate = byKind("gate")[0]!;
  const spawns = byKind("spawn");
  expect(spawns).toHaveLength(2);
  // Gate → both spawns; nudge decision → delivery in the thread lane;
  // escalation → seen.
  for (const spawn of spawns) expect(graph.edges.some((e) => e.from === gate.id && e.to === spawn.id)).toBe(true);
  const decision = byKind("decision")[0]!;
  const delivered = byKind("nudge-delivered")[0]!;
  expect(delivered.lane).toBe("thread:b");
  expect(graph.edges.some((e) => e.from === decision.id && e.to === delivered.id)).toBe(true);
  const escalation = byKind("escalation")[0]!;
  const seen = byKind("seen")[0]!;
  expect(graph.edges.some((e) => e.from === escalation.id && e.to === seen.id && e.tone === "warning")).toBe(true);
});

test("an accepted loom draws accept fed by each thread's latest green", () => {
  const l = { ...loom(), acceptedAt: Date.parse("2026-08-23T12:00:00Z") };
  const t0 = Date.parse("2026-08-23T10:00:00Z");
  const events: LoomEvent[] = [
    { at: t0, actor: "machine", kind: "verify", thread: "a", ok: false, commit: "old", detail: "red" },
    { at: t0 + 1000, actor: "machine", kind: "verify", thread: "a", ok: true, commit: "new", detail: "green" },
    { at: t0 + 2000, actor: "machine", kind: "verify", thread: "b", ok: true, commit: "bbb", detail: "green" },
  ];
  const graph = deriveGraph(l, events);
  const accept = graph.nodes.find((n) => n.kind === "accept")!;
  const greens = graph.nodes.filter((n) => n.kind === "verify" && n.tone === "success");
  expect(greens).toHaveLength(2);
  for (const green of greens) expect(graph.edges.some((e) => e.from === green.id && e.to === accept.id && e.tone === "success")).toBe(true);
  // The red run feeds nothing into accept.
  const red = graph.nodes.find((n) => n.tone === "destructive")!;
  expect(graph.edges.some((e) => e.from === red.id && e.to === accept.id)).toBe(false);
});
