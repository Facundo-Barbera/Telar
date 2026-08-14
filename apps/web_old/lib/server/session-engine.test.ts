// @ts-expect-error bun:test is provided by the test runtime; this workspace does not install @types/bun
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ackUltraWakes,
  addWatch,
  cancelWatch,
  claimNextSessionTurn,
  createLoom,
  enqueueSessionTurn,
  markSessionTurnRunning,
  readSessionQueue,
  saveLoom,
  ultraWakeChannel,
} from "@telar/core";
import { endChatRun, registerChatRun } from "@/lib/chat-runs";
import { upsertChatStub } from "@/lib/store";
import { ULTRA_WAKE_SENTINEL } from "@/lib/ultra-wake";
import {
  assertQueuedTurnSucceeded,
  kickSessionQueue,
  registerSessionTurnExecutor,
  scanSessionMachinery,
  startSessionMachineryReactor,
  stopSessionMachineryReactor,
  sweepSessionMachinery,
} from "./session-engine";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-session-engine-"));
const originalHome = process.env.TELAR_HOME;
process.env.TELAR_HOME = root;

beforeEach(() => {
  process.env.TELAR_HOME = root;
});

afterAll(() => {
  stopSessionMachineryReactor();
  if (originalHome === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const session = (label: string) => `engine-${label}-${crypto.randomUUID()}`;

// A chat row is what a machinery ticket's payload is composed from (the
// session's project/account, exactly as the renderer used to supply them), so
// every machinery test needs one.
const chat = (sessionId: string) =>
  upsertChatStub({
    id: sessionId,
    model: "sonnet",
    account: "test",
    project: "demo",
    userText: "hello",
  });

// A terminal Ultra run for one session, written straight to disk: the wake
// projection is derived from the manifest and never from a published event
// (packages/core/src/ultra/wake.ts's header), so a fixture needs nothing else.
function terminalUltraRun(sessionId: string, terminalAt: number): string {
  const runId = `u${crypto.randomUUID().replace(/-/g, "")}`;
  const dir = path.join(root, "ultra", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      runId,
      sessionId,
      meta: { name: "nightly sweep", description: "d", phases: [] },
      state: "done",
      spend: 0.5,
      result: "swept",
      startedAt: terminalAt - 1000,
      updatedAt: terminalAt,
    }),
  );
  return runId;
}

describe("server session queue dispatcher", () => {
  test("rejects an HTTP 200 stream whose terminal event says it was aborted", async () => {
    const body = [
      'event: done\ndata: {"subtype":"aborted"}\n\n',
      'event: closed\ndata: {}\n\n',
    ].join("");
    await expect(assertQueuedTurnSucceeded(new Response(body))).rejects.toThrow(
      "queued turn was aborted",
    );
  });

  test("accepts a successful terminal stream", async () => {
    const body = [
      'event: done\ndata: {"subtype":"success"}\n\n',
      'event: closed\ndata: {}\n\n',
    ].join("");
    await expect(assertQueuedTurnSucceeded(new Response(body))).resolves.toBeUndefined();
  });

  test("runs accepted turns FIFO without a renderer and commits each item", async () => {
    const id = session("fifo");
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "one", payload: { message: "one" } });
    enqueueSessionTurn(id, { idempotencyKey: "two", payload: { message: "two" } });

    await kickSessionQueue(id);

    expect(seen).toEqual(["one", "two"]);
    expect(readSessionQueue(id).items.map((item) => item.state)).toEqual([
      "committed",
      "committed",
    ]);
  });

  test("waits behind an already-active direct turn", async () => {
    const id = session("active");
    const runId = `run-${crypto.randomUUID()}`;
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "later", payload: { message: "later" } });
    expect(registerChatRun(runId, new AbortController(), id)).toBe(true);

    await kickSessionQueue(id);
    expect(seen).toEqual([]);
    expect(readSessionQueue(id).items[0]?.state).toBe("queued");

    endChatRun(runId);
    await kickSessionQueue(id);
    expect(seen).toEqual(["later"]);
  });

  test("records a failed item and the messages behind it keep going", async () => {
    // One message failing is that message's error, never a session mode
    // (feel contract rules 11/12): the failed item keeps its reason and its
    // own Retry, the queue is NOT paused, and the next item still runs —
    // recovery takes zero clicks in zero places.
    const id = session("failure");
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      const message = (payload as { message: string }).message;
      if (message === "bad") throw new Error("profile rejected");
      seen.push(message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "bad", payload: { message: "bad" } });
    enqueueSessionTurn(id, { idempotencyKey: "held", payload: { message: "held" } });

    await kickSessionQueue(id);

    const queue = readSessionQueue(id);
    expect(queue.paused).toBe(false);
    expect(queue.items[0]?.state).toBe("failed");
    expect(queue.items[0]?.error).toBe("profile rejected");
    expect(queue.items[1]?.state).toBe("committed");
    expect(seen).toEqual(["held"]);
  });
});

describe("server-authored machinery tickets", () => {
  test("one terminal outcome yields exactly one wake ticket, however often it is scanned", async () => {
    // The durable key replaces the client's in-memory announced-runs Set, which
    // a remount reset — the loop that produced (D8).
    const id = session("wake-once");
    chat(id);
    const runId = terminalUltraRun(id, 1_700_000_000_000);

    scanSessionMachinery(id);
    scanSessionMachinery(id);
    scanSessionMachinery(id);

    const items = readSessionQueue(id).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.idempotencyKey).toBe(`wake:${runId}:1700000000000`);
    expect(items[0]?.kind).toBe("wake");
    expect(items[0]?.hidden).toBe(true);
    expect((items[0]?.payload as { message: string }).message).toBe(ULTRA_WAKE_SENTINEL);

    // Settled here so a later test's heartbeat — which sweeps every session an
    // Ultra run names — finds nothing claimable in this one. The run stays
    // pending (nothing acked it), and the scan still mints no second ticket:
    // the committed item keeps the key.
    registerSessionTurnExecutor(async () => {});
    await kickSessionQueue(id);
    scanSessionMachinery(id);
    expect(readSessionQueue(id).items).toHaveLength(1);
  });

  test("a claimed wake ticket whose outcome was already delivered commits without running", async () => {
    // The server-side SF-2 stale-drop: an intervening human turn already acked
    // the wake, so the outcome was delivered and the ticket speaks for nothing.
    // This is also T10's collapse — the tickets behind the one that ran find
    // their own runs stamped by the appendix it carried.
    const id = session("wake-delivered");
    chat(id);
    const runId = terminalUltraRun(id, 1_700_000_100_000);
    scanSessionMachinery(id);
    ackUltraWakes(id, [runId]);
    let calls = 0;
    registerSessionTurnExecutor(async () => {
      calls += 1;
    });

    await kickSessionQueue(id);

    expect(calls).toBe(0);
    expect(readSessionQueue(id).items[0]?.state).toBe("committed");
  });

  test("a wake ticket whose mailbox merely READS empty still runs its turn", async () => {
    // THE DROP TAKES POSITIVE EVIDENCE, never the absence of a mailbox entry.
    // `pendingUltraWakes` swallows every read failure it meets, so an
    // unreadable or half-written manifest reports an empty mailbox — and a
    // guard keyed on emptiness committed the only ticket that terminal would
    // ever have, with the retained key deduping every rescan afterwards. The
    // wake was lost silently and permanently; delivered twice is the direction
    // this module tolerates, lost is not.
    const id = session("wake-unreadable");
    chat(id);
    const runId = terminalUltraRun(id, 1_700_000_200_000);
    scanSessionMachinery(id);
    fs.writeFileSync(path.join(root, "ultra", runId, "manifest.json"), "{ truncated");
    let calls = 0;
    registerSessionTurnExecutor(async () => {
      calls += 1;
    });

    await kickSessionQueue(id);

    expect(calls).toBe(1);
    expect(readSessionQueue(id).items[0]?.state).toBe("committed");
  });

  test("a machinery ticket recovered as ambiguous does not bar the session's queue", async () => {
    // The process died with a wake turn running, so recovery calls that ticket
    // `ambiguous` — and ONE ambiguous item makes claimNextSessionTurn return
    // null for every later message until a human presses Retry or Discard on
    // it. A hidden ticket has no line to carry either button, so the session
    // simply stopped sending, with no visible cause. Discard, never Retry:
    // `ambiguous` means the turn may already have reached the provider.
    const id = session("machinery-ambiguous");
    chat(id);
    enqueueSessionTurn(id, {
      idempotencyKey: "wake:u-crashed:5",
      payload: { message: ULTRA_WAKE_SENTINEL, sessionId: id },
      kind: "wake",
      hidden: true,
    });
    const claimed = claimNextSessionTurn(id, "test");
    markSessionTurnRunning(id, claimed!.item.idempotencyKey, claimed!.claimToken);
    enqueueSessionTurn(id, {
      idempotencyKey: "after-the-crash",
      payload: { message: "after the crash" },
    });
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });

    await kickSessionQueue(id); // this session's first kick: recovery runs here

    expect(seen).toEqual(["after the crash"]);
    const items = readSessionQueue(id).items;
    expect(items.find((item) => item.idempotencyKey === "wake:u-crashed:5")?.state).toBe(
      "cancelled",
    );
  });

  test("a machinery ticket whose turn fails is settled, not left waiting for a button", async () => {
    // `failed` is answered by Retry/Discard on the line, and machinery has no
    // line — an item left there is invisible forever AND keeps the strip's
    // queue poll running for the life of the tab. The reason is kept: the item
    // is history now, and history that drops why it exists is worse than none.
    const id = session("machinery-failed");
    chat(id);
    registerSessionTurnExecutor(async () => {
      throw new Error("profile rejected");
    });
    enqueueSessionTurn(id, {
      idempotencyKey: "watch:w-dead:blocked",
      payload: { message: "[watcher] loom l-1 reached blocked.", sessionId: id },
      kind: "watch",
    });

    await kickSessionQueue(id);

    const item = readSessionQueue(id).items[0];
    expect(item?.state).toBe("cancelled");
    expect(item?.error).toBe("profile rejected");
  });

  test("a boot sweep drains a queued turn nobody kicked", async () => {
    // Defect D5, the synchronous answer: no clock — the sweep runs once at boot
    // and once per work-creating event (the reactor). This pins the boot half:
    // an item queued into a dead process is drained by the restart's one sweep.
    const id = session("sweep");
    chat(id);
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    enqueueSessionTurn(id, { idempotencyKey: "unkicked", payload: { message: "unkicked" } });

    sweepSessionMachinery();
    await kickSessionQueue(id); // joins the sweep's in-flight dispatcher

    expect(seen).toEqual(["unkicked"]);
    expect(readSessionQueue(id).items[0]?.state).toBe("committed");
  });

  test("a watched loom in a trigger state yields one ticket, and it is a VISIBLE turn", async () => {
    // The wake's sibling producer, and the one the client's `lastFiredRef` Map
    // used to own — an in-memory latch that died with the component. The key
    // carries the state because the re-arm rule is per (watch, state).
    const id = session("watch-fires");
    chat(id);
    const loom = createLoom({
      project: "demo",
      kind: "story",
      title: "ship the strip",
      prompt: "p",
      account: "test",
    });
    saveLoom({ ...loom, state: "blocked" });
    const watch = addWatch({ loomId: loom.id, sessionId: id, triggerStates: ["blocked"] });

    scanSessionMachinery(id);
    scanSessionMachinery(id);

    const items = readSessionQueue(id).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.idempotencyKey).toBe(`watch:${watch.id}:blocked`);
    expect(items[0]?.kind).toBe("watch");
    // NOT hidden: a watcher turn is meant to be read. Only the wake's wire text
    // is a sentinel.
    expect(items[0]?.hidden).toBeUndefined();
    expect((items[0]?.payload as { message: string }).message).toContain("ship the strip");

    // Settled, and the watch cancelled, so a later tick sweeping every session
    // under this root finds nothing of this test's left to claim.
    registerSessionTurnExecutor(async () => {});
    await kickSessionQueue(id);
    cancelWatch(watch.id);
    expect(readSessionQueue(id).items[0]?.state).toBe("committed");
  });

  test("a watched loom outside its trigger states mints nothing", () => {
    const id = session("watch-quiet");
    chat(id);
    const loom = createLoom({
      project: "demo",
      kind: "story",
      title: "still running",
      prompt: "p",
      account: "test",
    });
    saveLoom({ ...loom, state: "running" });
    const watch = addWatch({ loomId: loom.id, sessionId: id, triggerStates: ["blocked", "done"] });

    scanSessionMachinery(id);

    expect(readSessionQueue(id).items).toEqual([]);
    cancelWatch(watch.id);
  });

  test("the boot sweep authors a watch ticket for a session no tab has ever opened", async () => {
    // machinerySessionIds' watch half (defect D8): the session is named by the
    // watch file alone — it has no queue file at all until this sweep writes one.
    const id = session("watch-pulse");
    chat(id);
    const loom = createLoom({
      project: "demo",
      kind: "story",
      title: "needs a human",
      prompt: "p",
      account: "test",
    });
    saveLoom({ ...loom, state: "needs-review" });
    const watch = addWatch({ loomId: loom.id, sessionId: id, triggerStates: ["needs-review"] });
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });

    sweepSessionMachinery();
    await kickSessionQueue(id); // joins the sweep's in-flight dispatcher

    expect(seen.some((text) => text.includes("needs a human"))).toBe(true);
    expect(readSessionQueue(id).items[0]?.state).toBe("committed");
    cancelWatch(watch.id);
  });

  test("boot starts the reactor even when queue recovery throws", async () => {
    // The reactor is the event half of D5's guarantee and register() is its only
    // call site. The heartbeat it replaces used to share one try with the boot
    // recovery loop, so a TELAR_HOME that cannot be enumerated took it down for
    // the life of the process — the guarantee nested under an unrelated failure.
    // The reactor starts BEFORE the boot sweep, so the sweep throwing on the
    // same corrupt root (listSessionQueueIds rethrows non-ENOENT) must not
    // unwind it.
    const bootRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telar-boot-"));
    // A FILE where the sessions directory belongs: listSessionQueueIds rethrows
    // anything but ENOENT, so boot recovery throws before it kicks anything.
    fs.writeFileSync(path.join(bootRoot, "sessions"), "not a directory");
    const originalRuntime = process.env.NEXT_RUNTIME;
    process.env.TELAR_HOME = bootRoot;
    process.env.NEXT_RUNTIME = "nodejs";
    stopSessionMachineryReactor();
    try {
      const { register } = await import("@/instrumentation");
      await register();
      // Already running: the second start is the assertion.
      expect(startSessionMachineryReactor()).toBe(false);
    } finally {
      stopSessionMachineryReactor();
      if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
      else process.env.NEXT_RUNTIME = originalRuntime;
      process.env.TELAR_HOME = root;
      fs.rmSync(bootRoot, { recursive: true, force: true });
    }
  });

  test("starting the reactor twice does not stack a second subscription", () => {
    // HMR re-evaluates this module; a second subscription would double-scan
    // (harmless — the ticket key dedupes) but leak handlers without bound.
    try {
      expect(startSessionMachineryReactor()).toBe(true);
      expect(startSessionMachineryReactor()).toBe(false);
    } finally {
      stopSessionMachineryReactor();
    }
    expect(startSessionMachineryReactor()).toBe(true);
    stopSessionMachineryReactor();
  });

  test("an ultra terminal PUBLISH kicks its session — no tab, no clock", async () => {
    // The event half of the synchronous design: the reactor turns the
    // `ultra:run-completed` publish into scan + kick the moment it fires. The
    // manifest is written before the publish (wake.ts's ordering guarantee),
    // so the scan this triggers already sees the outcome.
    const id = session("reactor");
    chat(id);
    const seen: string[] = [];
    registerSessionTurnExecutor(async (payload) => {
      seen.push((payload as { message: string }).message);
    });
    const runId = terminalUltraRun(id, 41_000);
    try {
      expect(startSessionMachineryReactor()).toBe(true);
      ultraWakeChannel().publish("run-completed", {
        runId,
        sessionId: id,
        messageId: "",
        state: "done",
        name: "nightly sweep",
        spendUsd: 0.5,
        terminalAt: 41_000,
        result: "swept",
      });
      await kickSessionQueue(id); // joins the reactor's in-flight dispatcher
    } finally {
      stopSessionMachineryReactor();
    }

    expect(seen).toEqual([ULTRA_WAKE_SENTINEL]);
    const item = readSessionQueue(id).items[0];
    expect(item?.idempotencyKey).toBe(`wake:${runId}:41000`);
    expect(item?.state).toBe("committed");
  });
});
