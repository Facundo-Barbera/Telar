// runCodexTurn's AUTO-compaction path — the `item.type === "contextCompaction"`
// branch inside `handleItem` — against the same scripted fake `codex
// app-server` as codex-compact-wire.test.ts, but driven through thread/start
// + turn/start instead of thread/compact/start. This is the ORDINARY-TURN
// half of the bug that made runCodexCompact hang forever: auto-compaction
// (Codex compacting its own context mid-turn, unprompted, with no
// `compact: true` anywhere on the request) fed off the exact same dead
// `thread/compacted` notification before the fix. Kept as its own file
// rather than folded into codex-compact-wire.test.ts because it exercises a
// different function (runCodexTurn, not runCodexCompact) through a different
// pair of requests (thread/start + turn/start, not thread/compact/start).
//
// A real mutation-testing pass (mutate `item.type === "contextCompaction"`
// in handleItem to a string that can never match) found NO test anywhere in
// this workspace caught it — normalizeCodexAutoCompact's own unit tests
// exercise the pure function directly, never the branch in handleItem that
// calls it, and nothing drove runCodexTurn through a fake subprocess at all.
// This file closes that gap.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this
// Next app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { runCodexTurn } from "./codex-app-server";

// `import.meta.url` + fileURLToPath rather than Bun's `import.meta.dir`: the
// latter is a Bun extension this workspace has no types for (same idiom as
// theme-contract.test.ts and codex-compact-wire.test.ts).
const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

let previousCodexBin: string | undefined;

beforeEach(() => {
  previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = FAKE_BIN;
});

afterEach(() => {
  if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCodexBin;
});

// AppServerClient spawns with EXACTLY this env — PATH so the fixture's
// `#!/usr/bin/env bun` shebang can find `bun`, and FAKE_CODEX_TURN_SCENARIO
// so the fixture (reading its OWN process.env, not this test file's) knows
// which notification sequence to play.
const fakeEnv = (turnScenario: string) => ({
  PATH: process.env.PATH ?? "",
  FAKE_CODEX_TURN_SCENARIO: turnScenario,
});

// Drains an AsyncGenerator with a hard deadline — same discipline as
// codex-compact-wire.test.ts's own `drain`: a generator that never yields
// `done` would otherwise hang this whole test file instead of failing it.
async function drain(
  gen: AsyncGenerator<{ type: string; [k: string]: unknown }>,
  timeoutMs = 5000,
): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runCodexTurn did not return within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        for await (const ev of gen) events.push(ev);
      })(),
      timeout,
    ]);
    return events;
  } finally {
    clearTimeout(timer!);
    await gen.return(undefined as never).catch(() => {});
  }
}

const baseOpts = (turnScenario: string) => ({
  prompt: "hello",
  cwd: process.cwd(),
  env: fakeEnv(turnScenario),
  model: "gpt-5.6-sol",
  sandbox: "read-only" as const,
  approvalPolicy: "never" as const,
  approvalsReviewer: "auto_review" as const,
});

describe("runCodexTurn's auto-compaction handling against a scripted app-server", () => {
  test("a mid-turn contextCompaction item completing emits an auto compact_end", async () => {
    const events = await drain(runCodexTurn(baseOpts("auto-compact-mid-turn")));
    // session, then the compaction's own compact_end (mid-turn, before the
    // turn's actual text — matches handleItem's own comment: it fires as
    // soon as the item completes, independent of anything the turn later
    // says), then the turn's ordinary final text.
    expect(events).toEqual([
      { type: "session", sessionId: "fake-thread" },
      { type: "compact_end", trigger: "auto", summary: null },
      { type: "text", itemId: "item-final", text: "done" },
    ]);
  });

  test("an ordinary turn with no compaction never emits compact_end", async () => {
    const events = await drain(runCodexTurn(baseOpts("plain")));
    expect(events).toEqual([
      { type: "session", sessionId: "fake-thread" },
      { type: "text", itemId: "item-final", text: "done" },
    ]);
  });
});
