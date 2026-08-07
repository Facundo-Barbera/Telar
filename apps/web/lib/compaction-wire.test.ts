// ISSUE #25 — a compaction used to be a pure state toggle: `compacting` on,
// `compacting` off, nothing recorded anywhere. This file covers the two ends
// that toggle now has: the store round-trip that makes the transcript's divider
// survive a reload, and (by source scan, since this app has no DOM test
// environment — same discipline as spawn-reveal.test.ts and
// session-meters-mount.test.ts) the wiring in the three surfaces in between.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

// Point the store at a throwaway home BEFORE importing it (store.test.ts idiom)
// — nothing here may touch the real ~/.telar.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "telar-compaction-"));
process.env.TELAR_HOME = TMP;
beforeEach(() => {
  process.env.TELAR_HOME = TMP;
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const store = await import("./store");

const sessionView = readFileSync(
  new URL("../components/session/session-view.tsx", import.meta.url),
  "utf8",
);
const meters = readFileSync(
  new URL("../components/session/session-meters.tsx", import.meta.url),
  "utf8",
);
const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
// The PreCompact/PostCompact notifiers moved into lib/server/turn-hooks.ts. The
// send/fold PAIRING is a property of the turn, not of a file, so the scan below
// reads the turn's two source files as one — splitting them would let a fold
// lose its send simply by the two landing on opposite sides of the boundary.
const turnHooks = readFileSync(new URL("./server/turn-hooks.ts", import.meta.url), "utf8");
// The SDKMessage→event projection moved to the server layer (the
// compact_boundary send now lives there; its fold stays in the route's loop,
// paired through the projection result's `compaction` field) — same rule as
// turn-hooks above: the turn is ONE scan unit however many files it spans.
const projector = readFileSync(
  new URL("../server/providers/claude/project-message.ts", import.meta.url),
  "utf8",
);
const turnSource = `${route}\n${turnHooks}\n${projector}`;
const storeSource = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
const sessionPage = readFileSync(
  new URL("../app/projects/[name]/sessions/[id]/page.tsx", import.meta.url),
  "utf8",
);

let seq = 0;
function seedChat(turns = 1): string {
  const id = `compaction-${++seq}`;
  for (let i = 0; i < turns; i++) {
    store.appendTurn({
      id,
      model: "sonnet",
      account: "personal",
      userMessage: { role: "user", parts: [{ type: "text", text: `q${i}` }] },
      assistantMessage: { role: "assistant", parts: [{ type: "text", text: `a${i}` }] },
      costUsd: 0,
    });
  }
  return id;
}

describe("recordCompactions (the divider survives a reload)", () => {
  test("persists a compaction beside the transcript, anchored by message count", () => {
    const id = seedChat(1);
    expect(
      store.recordCompactions(id, [
        { at: 1, trigger: "auto", preTokens: 152_000, postTokens: 41_000, durationMs: 4_200 },
      ]),
    ).toBe(true);
    const chat = store.getChat(id)!;
    expect(chat.compactions).toEqual([
      {
        at: 1,
        trigger: "auto",
        preTokens: 152_000,
        postTokens: 41_000,
        durationMs: 4_200,
        afterMessages: chat.messages.length,
      },
    ]);
  });

  test("adds no message, no turn, and no cost — a compaction is not a turn", () => {
    const id = seedChat(1);
    const before = store.getChat(id)!;
    store.recordCompactions(id, [{ at: 1, trigger: "manual" }]);
    const after = store.getChat(id)!;
    expect(after.messages).toEqual(before.messages);
    expect(after.turns).toBe(before.turns);
    expect(after.costUsd).toBe(before.costUsd);
    // SETTLE STAYS USER-DRIVEN — the harness reorganizing its own history must
    // not look like activity that reorders the session list.
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("accumulates across compactions, newest last", () => {
    const id = seedChat(1);
    store.recordCompactions(id, [{ at: 1, trigger: "manual" }]);
    seedChatTurn(id);
    store.recordCompactions(id, [{ at: 2, trigger: "auto" }]);
    const anchors = store.getChat(id)!.compactions!.map((c) => c.afterMessages);
    expect(anchors).toEqual([2, 4]);
  });

  test("records whether the turn below it re-measured, and says nothing when it did not", () => {
    // The flag the reloaded wheel reads (seedCompactedContext). Absent rather
    // than false when nothing re-measured, so a record written before the flag
    // existed and a compact-only request read identically.
    const remeasured = seedChat(1);
    store.recordCompactions(remeasured, [{ at: 1, trigger: "auto", postTokens: 41_000 }], true);
    expect(store.getChat(remeasured)!.compactions![0].remeasured).toBe(true);
    const compactOnly = seedChat(1);
    store.recordCompactions(compactOnly, [{ at: 1, trigger: "manual" }]);
    expect(store.getChat(compactOnly)!.compactions![0]).not.toHaveProperty("remeasured");
  });

  test("writes nothing for an unknown chat or an empty batch", () => {
    expect(store.recordCompactions("no-such-chat", [{ at: 1, trigger: "manual" }])).toBe(false);
    const id = seedChat(1);
    expect(store.recordCompactions(id, [])).toBe(false);
    expect(store.getChat(id)!.compactions).toBeUndefined();
  });
});

function seedChatTurn(id: string) {
  store.appendTurn({
    id,
    model: "sonnet",
    account: "personal",
    userMessage: { role: "user", parts: [{ type: "text", text: "more" }] },
    assistantMessage: { role: "assistant", parts: [{ type: "text", text: "ok" }] },
    costUsd: 0,
  });
}

describe("the route records what it streams", () => {
  test("folds every compaction event it sends through the SHARED reducer", () => {
    // The rule itself is tested for real in compaction.test.ts; what only a
    // source scan can pin is that neither side has grown a second copy of it.
    // Every send of a compaction event is paired with a fold of the same event.
    expect(route).toContain("compactionFold = foldCompactionEvent(compactionFold, event, facts)");
    for (const [event, sends] of [
      ["compacting", 3],
      ["compacted", 3],
      ["compact_boundary", 1],
    ] as const) {
      const folded = turnSource.match(new RegExp(`noteCompaction\\("${event}"`, "g")) ?? [];
      const sent = turnSource.match(new RegExp(`send\\("${event}"`, "g")) ?? [];
      expect(folded.length).toBe(sends);
      expect(sent.length).toBe(sends);
    }
    expect(turnSource).not.toContain("upsertCompaction(");
  });

  test("forwards Codex's mid-turn auto-compaction, which used to be dropped", () => {
    // runCodexTurn has always emitted compact_end for an unprompted
    // contextCompaction item; the turn switch simply had no case for it.
    const turnCases = route.match(/case "compact_start":\n\s+case "compact_end": \{/g);
    expect(turnCases?.length).toBe(1);
  });

  test("invents no post-compaction number for Codex", () => {
    // Verified against runCodexCompact: compact_end carries a null summary and
    // no counts at all. The wheel says "unknown" instead of guessing.
    const codexApp = readFileSync(new URL("./codex-app-server.ts", import.meta.url), "utf8");
    expect(codexApp).toContain("contextCompaction");
    expect(codexApp).not.toMatch(/compact_end[\s\S]{0,200}postTokens/);
    expect(route).toMatch(
      /noteCompaction\("compacted", \{ at: Date\.now\(\), trigger: nev\.trigger \}\)/,
    );
  });

  test("a compact-only request appends no turn", () => {
    // Claude's /compact runs a real query() and would otherwise reach appendTurn
    // — which deletes settledAt — for something no human drove.
    expect(route).toContain("if (capturedSession && !compact) {");
  });

  test("a compact-only request still reaches a refresh producer", () => {
    // It writes to usage.ndjson (logUsage above runs for it) and appends no
    // turn, and "saved" is the ONLY event whose client handler re-projects the
    // ledger — so without this the spend readouts silently drift.
    expect(route).toContain('if (recorded && compact) {\n                send("saved"');
    expect(sessionView).toMatch(/case "saved":[\s\S]{0,200}dispatchTelarRefresh/);
  });

  test("persists the boundary last, so its anchor is the settled transcript", () => {
    const recordAt = route.indexOf("recordCompactions(");
    const appendAt = route.lastIndexOf("appendTurn({");
    expect(recordAt).toBeGreaterThan(appendAt);
    expect(route).toContain("const compactionTarget = capturedSession ?? resumeTarget;");
    // The per-stream key stays out of chats.json.
    expect(route).toContain("compactionFold.entries.map(compactionFacts)");
  });

  test("tells the store whether anything re-measured after the compaction", () => {
    // The reloaded wheel cannot work this out from the anchor — a mid-turn
    // auto-compaction and a compact-only request land on the same one.
    expect(route).toContain("turnPersisted && contextRemeasured");
    // Both measurement sites clear it; every compaction event sets it false.
    expect(route.match(/contextRemeasured = true/g)?.length).toBe(2);
    expect(route).toMatch(/foldCompactionEvent\(compactionFold, event, facts\);\n\s+contextRemeasured = false;/);
  });
});

describe("the transcript's divider", () => {
  test("is a marker, not a message — no bubble, no role, no author", () => {
    expect(sessionView).toContain("kind: CONVERSATION_KINDS.marker");
    expect(sessionView).toContain("key: `compaction:${c.key}`");
    expect(sessionView).toContain("compactionMarkerText(c)");
    // The compaction branch of applyServerEvent still returns before the block
    // that would open an assistant bubble for it.
    expect(sessionView).toContain(
      'if (event === "compacting" || event === "compacted" || event === "compact_boundary") {',
    );
  });

  test("withholds a marker under the still-live last turn", () => {
    // Conversation marks only the LAST top-level item live; a divider appended
    // under a streaming turn would steal its liveness.
    expect(sessionView).toContain("!(busy && messageId === lastMessageId)");
  });

  test("seeds from the store, so it does not vanish on refresh", () => {
    expect(sessionView).toContain("seedTranscriptCompactions(");
    expect(sessionView).toContain("compactions?: CompactionRecord[]");
    expect(storeSource).toContain("compactions?: CompactionRecord[]");
    expect(sessionPage).toContain("compactions: chat.compactions");
  });

  test("runs the route's reducer rather than a second copy of its rule", () => {
    // Two hand-written lifecycles diverged: the client left `compacted` open
    // (so two Codex auto-compactions became ONE divider live) while the route
    // closed on it (two records on reload). There is now one rule, and this is
    // the only thing a source scan can add to compaction.test.ts: that the
    // client still calls it and owns no lifecycle of its own.
    expect(sessionView).toContain("foldCompactionEvent(compactionFoldRef.current, event, {");
    expect(sessionView).toContain("compactionFoldRef.current = fold");
    expect(sessionView).not.toContain("compactionSeqRef");
    expect(sessionView).not.toContain("openCompactionRef");
  });
});

describe("the context wheel updates at the compaction, not at the next turn", () => {
  test("reads the MERGED record, so the closing order cannot change it", () => {
    // Reading the single event instead would let Claude's count-free
    // "compacted" overwrite the boundary's real number with "unknown" whenever
    // it arrives second — an ordering this repo documents both ways and has
    // never traced. The merge itself is tested in compaction.test.ts.
    expect(sessionView).toContain('setCompactedContext(entry.postTokens ?? "unknown")');
    expect(sessionView).toMatch(
      /typeof compactedContext === "number"\s*\?\s*compactedContext/,
    );
    expect(sessionView).toContain("unknown={compactedContext === \"unknown\"}");
  });

  test("says it does not know rather than showing a stale number", () => {
    expect(meters).toContain("unknown = false");
    expect(meters).toContain("unknown?: boolean");
    // The wheel, the readout and the total all stop claiming a figure.
    expect(meters.match(/unknown\s*\?\s*"—"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(meters).toContain("size unknown since the last compaction");
  });

  test("stands down only for a turn that actually re-measured", () => {
    // `done` for a compact-only request carries no snapshot and context: 0 —
    // clearing on that would restore the very number this override replaced.
    expect(sessionView).toMatch(/setCompactedContext\(null\)/);
    expect(sessionView).toContain('payload.contextUsage?.source === "claude-sdk"');
  });

  test("still reads a real window: a compaction changes contents, not size", () => {
    expect(sessionView).toContain("contextUsage?.totalTokens ?? context");
    expect(meters).toContain("windowTokens?: number");
  });

  test("survives a reload with the same honesty", () => {
    expect(sessionView).toContain("seedCompactedContext(initialChat?.compactions");
  });
});
