// runCodexCompact against a REAL subprocess boundary — a scripted fake
// `codex app-server` (lib/fixtures/fake-codex-app-server.mjs), not a mock of
// AppServerClient's internals. This is the regression test for a bug found
// by driving the actual, live, ChatGPT-authenticated `codex app-server`
// 0.145.0 binary through a real on-demand compaction: the notification
// runCodexCompact originally waited for to end its loop — `thread/compacted`
// (ContextCompactedNotification) — was NEVER emitted, success or failure.
// The real completion signal is a `contextCompaction` item finishing (or,
// failing that, the connection's own turn/completed). Waiting on the wrong
// name meant the generator never returned on a SUCCESSFUL compaction: no
// `compact_end`, no closed SSE stream, a `compacting` indicator stuck true
// forever. See codex-app-server.ts's own comment on runCodexCompact for the
// full trace this fixture's scenarios are copied from.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this
// Next app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { runCodexCompact } from "./codex-app-server";

// `import.meta.url` + fileURLToPath rather than Bun's `import.meta.dir`: the
// latter is a Bun extension this workspace has no types for (same idiom as
// theme-contract.test.ts).
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

// AppServerClient spawns with EXACTLY this env (no merge with process.env —
// that's the caller's job in production, via accountEnv()): PATH so the
// fixture's `#!/usr/bin/env bun` shebang can find `bun` at all (without it,
// spawn fails with exit code 127 before a single byte of the fixture's own
// JSON-RPC ever runs), and FAKE_CODEX_SCENARIO so the fixture — reading
// its OWN process.env, not this test file's — knows which notification
// sequence to play. Setting FAKE_CODEX_SCENARIO on this test process (as an
// earlier version of this file did) is a no-op: it never reaches the child,
// which silently falls back to its "success" default regardless of what
// this file asked for.
const fakeEnv = (scenario: string) => ({ PATH: process.env.PATH ?? "", FAKE_CODEX_SCENARIO: scenario });

// Drains an AsyncGenerator with a hard deadline — a generator that never
// yields `done` (the exact shape of the original bug) would otherwise hang
// this whole test file instead of failing it.
async function drain(
  gen: AsyncGenerator<{ type: string; [k: string]: unknown }>,
  timeoutMs = 5000,
): Promise<{ type: string; [k: string]: unknown }[]> {
  const events: { type: string; [k: string]: unknown }[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`runCodexCompact did not return within ${timeoutMs}ms`)), timeoutMs);
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
    // If the timeout won the race, the generator is still suspended on its
    // own `await client.notifications.next()` — its `finally` (client.kill())
    // never ran, leaving the fake subprocess alive. Closing it explicitly
    // here (harmless no-op once the generator already returned normally)
    // keeps a red "did not return" test from also leaking a process.
    await gen.return(undefined as never).catch(() => {});
  }
}

describe("runCodexCompact against a scripted app-server", () => {
  test("a real contextCompaction item completing ends the compaction", async () => {
    const events = await drain(runCodexCompact({ threadId: "t1", env: fakeEnv("success") }));
    expect(events).toEqual([
      { type: "compact_start", trigger: "manual" },
      { type: "compact_end", trigger: "manual", summary: null },
    ]);
  });

  test("a failed compaction's error notification throws rather than hanging", async () => {
    await expect(
      drain(runCodexCompact({ threadId: "t1", env: fakeEnv("error") })),
    ).rejects.toThrow("fake compaction failure");
  });

  test("turn/completed alone (no item/completed) still ends the compaction — the defensive fallback", async () => {
    const events = await drain(runCodexCompact({ threadId: "t1", env: fakeEnv("turn-completed-fallback") }));
    expect(events).toEqual([
      { type: "compact_start", trigger: "manual" },
      { type: "compact_end", trigger: "manual", summary: null },
    ]);
  });

  // Anti-vacuity for the two tests above, WITHOUT reproducing the original
  // hang inside this suite (an async generator stuck on a never-resolving
  // internal `await` does not reliably unwind its `finally` on `.return()`
  // — confirmed empirically — so actually hanging one here would leak the
  // fake subprocess past this test run rather than just failing cleanly).
  // The hang itself — this exact fixture's "thread-compacted-only" scenario,
  // played against the PRE-FIX `runCodexCompact` — was proven live instead:
  // `bun` run against the real `codex app-server` 0.145.0 binary timed out
  // at 45s on the old code and returned in ~7.4s on the fixed code (see this
  // commit's message for the transcript). What IS safe to assert in-suite is
  // that success is keyed on the item, specifically — not on any notification
  // arriving at all.
  test("an unrelated notification between compact_start and completion is not mistaken for either", async () => {
    const events = await drain(runCodexCompact({ threadId: "t1", env: fakeEnv("success") }));
    // turn/started (played by every scenario, including this one, before the
    // real completion signal) must not have produced a THIRD event of its own.
    expect(events).toHaveLength(2);
  });

  // A real mutation-testing pass (mutate item.type === "contextCompaction" to
  // a string that can never match, run this suite, expect red) found that
  // the three tests above do NOT actually exercise that check: the defensive
  // turn/completed fallback below it yields the identical compact_end either
  // way, so a broken item-type comparison was silently masked. This is what
  // catches it instead — an item/completed for something OTHER than the
  // compaction lands first; if the item check were broken in a way that
  // matched too eagerly (or not at all, sailing past to the wrong item),
  // this compaction would report success (or the wrong outcome) without ever
  // observing the "error" that actually follows.
  test("an item/completed for a different item type is not mistaken for the compaction's own", async () => {
    await expect(
      drain(runCodexCompact({ threadId: "t1", env: fakeEnv("wrong-item-then-error") })),
    ).rejects.toThrow("wrong-item-then-error failure");
  });

  // The other half of that mutation-testing finding: the item check must
  // also be SUFFICIENT on its own, with no turn/completed to fall back on.
  // A too-strict (never-matching) item check would fall through to
  // "everything else, keep waiting" forever here — this is what `drain`'s
  // timeout would have caught, and did, before "item-only" existed.
  test("the compaction's own item/completed alone ends it — no turn/completed needed", async () => {
    const events = await drain(runCodexCompact({ threadId: "t1", env: fakeEnv("item-only") }));
    expect(events).toEqual([
      { type: "compact_start", trigger: "manual" },
      { type: "compact_end", trigger: "manual", summary: null },
    ]);
  });
});
