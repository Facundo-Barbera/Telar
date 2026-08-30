/**
 * The braid's load-bearing facts: the spine is the story in order, strands
 * exist only where history does, human moments are stations, and the only
 * cross-links are causes the machine is certain of.
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
  // Born BEFORE the fixture's event times — a real loom cannot have events
  // that precede its own creation, and the braid roots the story at birth.
  return {
    ...base(),
    createdAt: Date.parse("2026-08-24T09:00:00Z"),
  };
}

function base(): Loom {
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

const t0 = Date.parse("2026-08-24T10:00:00Z");

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
});

test("the spine is the story in order, and human moments are stations", () => {
  const events: LoomEvent[] = [
    { at: t0, actor: "weaver", kind: "proposal", detail: "proposed 2 threads" },
    { at: t0 + 1000, actor: "human", kind: "gate", detail: "cleared the gate" },
    { at: t0 + 4000, actor: "conductor", kind: "escalation", detail: "escalate: help" },
    { at: t0 + 5000, actor: "human", kind: "seen", detail: "saw the escalation" },
  ];
  const braid = deriveGraph(loom(), events);
  expect(braid.spine.map((n) => n.kind)).toEqual(["origin", "proposal", "gate", "escalation", "seen"]);
  // Stations = exactly the human moments (origin is the human's conversation).
  expect(braid.spine.filter((n) => n.station).map((n) => n.kind)).toEqual(["origin", "gate", "seen"]);
  // The story reads in row order.
  const rows = braid.spine.map((n) => n.row);
  expect([...rows].sort((x, y2) => x - y2)).toEqual(rows);
});

test("strands exist only where history does, and carry their own events", () => {
  const events: LoomEvent[] = [
    { at: t0, actor: "human", kind: "gate", detail: "cleared" },
    { at: t0 + 1000, actor: "machine", kind: "spawn", thread: "a", sessionId: "session_a", detail: "spawned a" },
    { at: t0 + 2000, actor: "machine", kind: "verify", thread: "a", ok: true, commit: "abc", detail: "green" },
  ];
  const braid = deriveGraph(loom(), events);
  expect(braid.strands.map((s) => s.slug)).toEqual(["a"]);
  expect(braid.strands[0].nodes.map((n) => n.kind)).toEqual(["spawn", "verify"]);
  // B never acted: not a strand, named as quiet instead.
  expect(braid.quietStrands).toEqual(["B"]);
});

test("a nudge is the one true cross-link, decision → delivery in the strand", () => {
  const events: LoomEvent[] = [
    { at: t0, actor: "machine", kind: "spawn", thread: "b", sessionId: "session_b", detail: "spawned b" },
    { at: t0 + 1000, actor: "conductor", kind: "decision", move: "nudge", thread: "b", detail: "nudge(b): stalled" },
    { at: t0 + 2000, actor: "conductor", kind: "nudge-delivered", thread: "b", sessionId: "session_b", detail: "nudged b" },
  ];
  const braid = deriveGraph(loom(), events);
  const decision = braid.spine.find((n) => n.kind === "decision")!;
  const delivered = braid.strands.find((s) => s.slug === "b")!.nodes.find((n) => n.kind === "nudge-delivered")!;
  expect(braid.arrows).toEqual([{ from: decision.id, to: delivered.id, tone: "verify" }]);
});

test("an accepted loom merges green strands into the accept station", () => {
  const l = { ...loom(), acceptedAt: t0 + 10_000 };
  const events: LoomEvent[] = [
    { at: t0, actor: "machine", kind: "spawn", thread: "a", sessionId: "session_a", detail: "spawned a" },
    { at: t0 + 1000, actor: "machine", kind: "verify", thread: "a", ok: true, commit: "abc", detail: "green" },
    { at: t0 + 2000, actor: "machine", kind: "spawn", thread: "b", sessionId: "session_b", detail: "spawned b" },
    { at: t0 + 3000, actor: "machine", kind: "verify", thread: "b", ok: false, commit: "bad", detail: "red" },
  ];
  const braid = deriveGraph(l, events);
  const accept = braid.spine.at(-1)!;
  expect(accept.kind).toBe("accept");
  expect(accept.station).toBe(true);
  expect(braid.strands.find((s) => s.slug === "a")!.mergesIntoAccept).toBe(true);
  // A red-latest strand does not merge — the braid does not launder evidence.
  expect(braid.strands.find((s) => s.slug === "b")!.mergesIntoAccept).toBe(false);
});
