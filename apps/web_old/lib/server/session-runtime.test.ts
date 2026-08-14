// THE TURN-END POLICY IS THE FIX (#28), so it is what these tests pin: a turn
// feed ends AT THE RESULT, background tasks hold the RUNTIME (never the feed),
// detached messages reach the window sink (rendered, not dropped), the roster
// emptying while detached settles the window exactly once, and the input
// channel stays open for the next turn. The query is faked; every behaviour
// here is host-side policy, not SDK behaviour.

// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { acquireSessionRuntime, closeSessionRuntime, interruptSessionRuntime } from "./session-runtime";

// A controllable fake query: the pump for-awaits it; tests push SDK messages
// in and observe the runtime's routing. Also records what came through the
// INPUT channel, so the push()->query wiring is provable.
function fakeQuery() {
  const out: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const emitted: SDKUserMessage[] = [];

  const emit = (msg: unknown) => {
    out.push(msg as SDKMessage);
    wake?.();
    wake = null;
  };
  const finish = () => {
    done = true;
    wake?.();
    wake = null;
  };

  // F2: interruptSessionRuntime calls query.interrupt() — tests swap this
  // out per scenario (receipt, still_queued, rejection).
  let interruptImpl: () => Promise<unknown> = async () => ({ still_queued: [] });
  const query = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (out.length) yield out.shift() as SDKMessage;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    interrupt: () => interruptImpl(),
  } as unknown as Query;

  return {
    query,
    emit,
    finish,
    emitted,
    setInterrupt: (impl: () => Promise<unknown>) => {
      interruptImpl = impl;
    },
  };
}

let keyCounter = 0;
function makeRuntime(opts?: {
  fingerprint?: string;
  key?: string;
  settleLingerMs?: number;
  continuationWatchdogMs?: number;
}) {
  const fq = fakeQuery();
  const key = opts?.key ?? `test-run-${++keyCounter}`;
  const { runtime, created } = acquireSessionRuntime({
    key,
    fingerprint: opts?.fingerprint ?? "fp-1",
    settleLingerMs: opts?.settleLingerMs ?? 20,
    continuationWatchdogMs: opts?.continuationWatchdogMs ?? 400,
    create: ({ input }) => {
      // Drain the input channel in the background, recording what arrived —
      // the real query does exactly this over stdin.
      void (async () => {
        for await (const m of input) fq.emitted.push(m);
      })();
      return fq.query;
    },
  });
  return { runtime, created, ...fq, key };
}

const user = (text: string): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: text },
});

const assistant = { type: "assistant", message: { content: [] } };
const result = { type: "result", subtype: "success" };
const tasksChanged = (n: number) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}` })),
});

async function collect(feed: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = [];
  for await (const m of feed) seen.push(m);
  return seen;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("session runtime", () => {
  test("the runtime keeps a bounded CLI stderr tail (issue #78)", () => {
    // The first empty turn had no forensics: the CLI's stderr went nowhere.
    // The tail lives on the RUNTIME (the process outlives its turns) and is
    // bounded — a crashing CLI can dump kilobytes, a diagnostic wants the end.
    const rt = makeRuntime();
    rt.runtime.noteStderr("first\nsecond\n");
    expect(rt.runtime.stderrLines).toEqual(["first", "second"]);
    for (let i = 0; i < 200; i++) rt.runtime.noteStderr(`line-${i}`);
    expect(rt.runtime.stderrLines.length).toBe(80);
    expect(rt.runtime.stderrLines.at(-1)).toBe("line-199");
    rt.runtime.closeNow("test over");
  });

  test("pushed messages reach the query's input channel", async () => {
    const rt = makeRuntime();
    rt.runtime.push(user("hello"));
    await tick();
    expect(rt.emitted.map((m) => m.message.content)).toEqual(["hello"]);
    rt.runtime.closeNow("test over");
  });

  test("a turn feed carries messages and ends at result when nothing is live", async () => {
    const rt = makeRuntime();
    const feed = rt.runtime.beginTurn("run-1");
    rt.emit(assistant);
    rt.emit(result);
    const seen = await collect(feed);
    expect(seen.map((m) => (m as { type: string }).type)).toEqual(["assistant", "result"]);
    expect(rt.runtime.turnActive).toBe(false);
    // The runtime survives its turn — that is the whole point.
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test over");
  });

  test("the feed ends AT the result even while background tasks are live", async () => {
    const rt = makeRuntime();
    const feed = rt.runtime.beginTurn("run-1");
    rt.emit(tasksChanged(1)); // a background agent is running
    rt.emit(result);
    const seen = await collect(feed); // returns immediately — no grace to wait out
    expect(seen.length).toBe(2);
    expect(rt.runtime.turnActive).toBe(false);
    // The RUNTIME and its tasks survive the feed — that is the whole point.
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test over");
  });

  test("the roster is KEPT AS A LIST, descriptions and all, and replaced wholesale", async () => {
    // It used to be `liveTaskCount`, a length — so the descriptions died at the
    // point of receipt and the pinned environment could not name a single piece
    // of background work. REPLACE, never merge: the payload is the full set
    // after the change (the SDK's own level-signal contract).
    const rt = makeRuntime();
    rt.runtime.beginTurn("run-1");
    rt.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "t1", task_type: "bash", description: "bun run test:web" },
        { task_id: "t2", task_type: "agent", description: "explore lib" },
      ],
    });
    await tick();
    expect(rt.runtime.liveTasks).toEqual([
      { id: "t1", type: "bash", description: "bun run test:web" },
      { id: "t2", type: "agent", description: "explore lib" },
    ]);
    rt.emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "t2", task_type: "agent", description: "explore lib" }],
    });
    await tick();
    expect(rt.runtime.liveTasks).toEqual([
      { id: "t2", type: "agent", description: "explore lib" },
    ]);
    rt.runtime.closeNow("test over");
  });

  test("detached traffic reaches the window sink, and the roster emptying settles it once", async () => {
    // Short watchdog: the roster's empty transition now holds the wake span
    // (see the continuation-hold tests below), and this scenario's wake
    // never comes — the settle this test watches for is the watchdog's.
    const rt = makeRuntime({ settleLingerMs: 20, continuationWatchdogMs: 40 });
    const feed = rt.runtime.beginTurn("run-1");
    const sank: string[] = [];
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: (m) => sank.push((m as { type: string }).type),
      onSettled: () => settled++,
    };
    rt.emit(tasksChanged(1));
    rt.emit(result);
    await collect(feed); // turn over; sink survives detach
    // The background agent keeps talking — PARENTED, as forwardSubagentText
    // really relays it. (An unparented detached assistant message is the
    // main thread's own auto-continuation and holds the watchdog instead —
    // its own test below.)
    rt.emit({ ...assistant, parent_tool_use_id: "spawn-1" });
    await tick();
    expect(sank).toEqual(["assistant"]);
    expect(settled).toBe(0);
    expect(rt.runtime.detachedMessages).toBe(1);
    rt.emit(tasksChanged(0)); // roster empties while detached → linger arms
    await tick();
    expect(settled).toBe(0); // not yet — the linger is what closes it
    await sleep(60); // > the 20ms test linger
    expect(settled).toBe(1);
    expect(rt.runtime.windowSink).toBeNull();
    // Later strays are counted but the window does not settle twice.
    rt.emit(assistant);
    await sleep(40);
    expect(settled).toBe(1);
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test over");
  });

  test("the settle linger re-arms on trailing messages, so a late task_notification still renders", async () => {
    // The live failure this pins: the CLI updates the roster to empty BEFORE
    // forwarding a completing agent's task_notification. An immediate settle
    // dropped that notification and the agent's tab showed Working forever.
    // Watchdog at 60: the roster transition holds the wake span now, and
    // this scenario's wake never comes — the late notification must render
    // inside that hold and the watchdog must still bound it.
    const rt = makeRuntime({ settleLingerMs: 40, continuationWatchdogMs: 60 });
    const feed = rt.runtime.beginTurn("run-1");
    const sank: string[] = [];
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: (m) => sank.push((m as { type?: string; subtype?: string }).subtype ?? (m as { type: string }).type),
      onSettled: () => settled++,
    };
    rt.emit(tasksChanged(1));
    rt.emit(result);
    await collect(feed);
    rt.emit(tasksChanged(0)); // roster empties FIRST...
    await sleep(15); // ...linger armed, not yet fired...
    rt.emit({ type: "system", subtype: "task_notification", tool_use_id: "t1", status: "completed" });
    await tick();
    // ...the trailing notification was SUNK (rendered), not dropped...
    expect(sank).toContain("task_notification");
    expect(settled).toBe(0);
    // ...and the re-armed linger settles only after true silence.
    await sleep(80);
    expect(settled).toBe(1);
    rt.runtime.closeNow("test over");
  });

  test("beginTurn clears a previous window's sink — the new POST owns rendering", async () => {
    const rt = makeRuntime();
    rt.runtime.windowSink = { canUseTool: null, onDetachedMessage: () => {}, onSettled: () => {} };
    const feed = rt.runtime.beginTurn("run-2");
    expect(rt.runtime.windowSink).toBeNull();
    rt.emit(result);
    await collect(feed);
    rt.runtime.closeNow("test over");
  });

  test("Stop between turns FLUSHES the window, it does not drop it (issue #76)", async () => {
    // The measured failure: three sub-agents completed, their
    // task_notifications lived only in the sink's turn state, the user
    // pressed Stop — closeNow nulled the sink without calling anything, and
    // a reload rolled every settled agent back to "running" while the wake
    // response vanished under a marker promising "kept what arrived".
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-flush");
    let settled = 0;
    let displaced = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
      onDisplaced: () => displaced++,
    };
    // The presence line's Stop between turns is exactly closeSessionRuntime.
    expect(closeSessionRuntime("sess-flush")).toBe(true);
    expect(settled).toBe(1); // the window got its ENDING — the full flush
    expect(displaced).toBe(0);
    expect(rt.runtime.windowSink).toBeNull();
    // A second close cannot flush twice — the sink was consumed.
    rt.runtime.closeNow("again");
    expect(settled).toBe(1);
  });

  test("a NEW TURN displaces the sink through onDisplaced — persist, but no window ending", async () => {
    // Displacement is not settlement: the window continues under the new
    // turn (still-live agents ride its feed), so the flush must persist what
    // arrived without the terminal ceremony — onDisplaced, never onSettled.
    const rt = makeRuntime();
    let settled = 0;
    let displaced = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
      onDisplaced: () => displaced++,
    };
    const feed = rt.runtime.beginTurn("run-2");
    expect(displaced).toBe(1);
    expect(settled).toBe(0);
    expect(rt.runtime.windowSink).toBeNull();
    rt.emit(result);
    await collect(feed);
    rt.runtime.closeNow("test over");
  });

  test("the PUMP'S OWN END flushes the sink — a CLI death mid-window is a teardown path too", async () => {
    // The one teardown path issue #76's sweep missed: the CLI process dying
    // (its message iterator ending) while a detached window was still open.
    // Everything the sink accumulated — completions, the continuation's parts
    // — exists only in its closure until a flush writes it through, and the
    // pump's finally used to just delete the runtime: the UI had shown the
    // work arriving live over SSE, the store never heard of it, and no
    // "closed" event ever ended the window for a reconnecting tail.
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-pump-death");
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
    };
    rt.finish(); // the subprocess exits: the query's iterator simply ends
    await tick();
    expect(settled).toBe(1); // the window got its ending — the full flush
    expect(rt.runtime.windowSink).toBeNull();
    expect(rt.runtime.closed).toBe(true);
    // A later Stop cannot flush twice — the sink was consumed.
    rt.runtime.closeNow("again");
    expect(settled).toBe(1);
  });

  test("a flush that throws never breaks the teardown — best-effort, like the settle path", async () => {
    const rt = makeRuntime();
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => {
        throw new Error("store unavailable");
      },
    };
    rt.runtime.closeNow("stop");
    expect(rt.runtime.closed).toBe(true);
    expect(rt.runtime.windowSink).toBeNull();
  });

  test("messages between turns are consumed and counted, and the next turn attaches cleanly", async () => {
    const rt = makeRuntime();
    rt.emit(assistant);
    await tick();
    expect(rt.runtime.detachedMessages).toBe(1);
    const feed = rt.runtime.beginTurn("run-2");
    rt.emit(result);
    const seen = await collect(feed);
    expect(seen.length).toBe(1);
    rt.runtime.closeNow("test over");
  });

  test("adoptSession re-keys the runtime so the next turn finds it by session id", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-abc");
    const again = acquireSessionRuntime({
      key: "sess-abc",
      fingerprint: "fp-1",
      create: () => {
        throw new Error("must reuse, not create");
      },
    });
    expect(again.created).toBe(false);
    expect(again.runtime).toBe(rt.runtime);
    rt.runtime.closeNow("test over");
  });

  test("a fingerprint change closes the old runtime and creates a fresh one", async () => {
    const a = makeRuntime({ key: "fp-change", fingerprint: "fp-A" });
    const b = makeRuntime({ key: "fp-change", fingerprint: "fp-B" });
    expect(b.created).toBe(true);
    expect(b.runtime).not.toBe(a.runtime);
    b.runtime.closeNow("test over");
    // a was closed gracefully: its input channel ended.
    a.finish();
    await tick();
    expect(a.runtime.turnActive).toBe(false);
  });

  test("detachTurn clears the slots and closes a still-open feed", async () => {
    const rt = makeRuntime();
    const feed = rt.runtime.beginTurn("run-1");
    rt.runtime.slots.canUseTool = (async () => ({ behavior: "allow" })) as never;
    rt.runtime.slots.runId = "run-1";
    rt.runtime.detachTurn();
    expect(rt.runtime.slots.canUseTool).toBeNull();
    expect(rt.runtime.slots.runId).toBeNull();
    expect(rt.runtime.turnActive).toBe(false);
    const seen = await collect(feed);
    expect(seen).toEqual([]);
    rt.runtime.closeNow("test over");
  });

  test("closeSessionRuntime kills a runtime with no turn attached (Stop between turns)", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-stop");
    expect(closeSessionRuntime("sess-stop")).toBe(true);
    expect(rt.runtime.closed).toBe(true);
    expect(closeSessionRuntime("sess-stop")).toBe(false);
  });

  test("a detached auto-continuation SURVIVES its thinking silence — the watchdog holds the window", async () => {
    // The live failure this pins (owner's find on nightly .4): the last
    // task_notification woke the SDK's auto-continuation, its extended-
    // thinking gap outlasted the short linger, and the window closed
    // mid-thought — the continuation's tool calls and final answer were
    // generated into a sink-less runtime and dropped.
    const rt = makeRuntime({ settleLingerMs: 20, continuationWatchdogMs: 200 });
    const feed = rt.runtime.beginTurn("run-1");
    const sank: string[] = [];
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: (m) => sank.push((m as { type: string }).type),
      onSettled: () => settled++,
    };
    rt.emit(tasksChanged(1));
    rt.emit(result);
    await collect(feed);
    rt.emit(tasksChanged(0)); // roster empties → short linger arms
    await tick();
    // The continuation begins: one stream event, then SILENCE (thinking).
    rt.emit({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } });
    await sleep(60); // > the 20ms short linger — the old code settled here
    expect(settled).toBe(0);
    expect(rt.runtime.windowSink).not.toBeNull();
    // The continuation delivers its answer and its OWN result — endgame:
    // the short linger takes back over and the window settles normally.
    rt.emit(assistant);
    rt.emit({ type: "result", subtype: "success" });
    await sleep(60);
    expect(settled).toBe(1);
    expect(sank).toContain("assistant");
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test over");
  });

  test("the roster emptying OPENS the continuation hold — the wake is expected, not discovered", async () => {
    // The lost ".5 shipped" wake (issue #71, third dropped wake in one day):
    // completion marker → 1.5s of model-latency silence → window settled →
    // the wake's whole response generated into a sink-less runtime, dropped
    // from screen and store alike. The old doctrine ("control chatter alone
    // never extends past the short linger") armed the watchdog only once
    // generation was SEEN — and the latency gap is exactly where the wake
    // died. The empty transition itself is the SDK's wake trigger, so it
    // holds the watchdog span from the start.
    const rt = makeRuntime({ settleLingerMs: 20, continuationWatchdogMs: 200 });
    const feed = rt.runtime.beginTurn("run-1");
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
    };
    rt.emit(tasksChanged(1));
    rt.emit(result);
    await collect(feed);
    rt.emit(tasksChanged(0)); // the wake trigger
    rt.emit({ type: "system", subtype: "task_notification", tool_use_id: "t1", status: "completed" });
    await sleep(60); // far past the 20ms linger — the old rule settled HERE
    expect(settled).toBe(0); // held: the wake is expected
    // The wake arrives after the latency gap and completes — its own result
    // returns the window to the short linger, the endgame it was built for.
    rt.emit(assistant);
    rt.emit({ type: "result", subtype: "success" });
    await sleep(60);
    expect(settled).toBe(1);
    rt.runtime.closeNow("test over");
  });

  test("a wake that never comes settles at the watchdog, not never", async () => {
    const rt = makeRuntime({ settleLingerMs: 20, continuationWatchdogMs: 120 });
    const feed = rt.runtime.beginTurn("run-1");
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
    };
    rt.emit(tasksChanged(1));
    rt.emit(result);
    await collect(feed);
    rt.emit(tasksChanged(0));
    await sleep(60);
    expect(settled).toBe(0); // held, awaiting the wake…
    await sleep(120);
    expect(settled).toBe(1); // …but the watchdog is still a real bound
    rt.runtime.closeNow("test over");
  });

  test("control chatter with NO wake pending settles on the short linger", async () => {
    // No roster transition ever happened — nothing is expected, and stray
    // control-plane messages must not hold the window on the long watchdog.
    const rt = makeRuntime({ settleLingerMs: 20, continuationWatchdogMs: 5_000 });
    const feed = rt.runtime.beginTurn("run-1");
    let settled = 0;
    rt.runtime.windowSink = {
      canUseTool: null,
      onDetachedMessage: () => {},
      onSettled: () => settled++,
    };
    rt.emit(result); // the turn ends with no background tasks at all
    await collect(feed);
    rt.emit({ type: "system", subtype: "task_notification", tool_use_id: "prev-turn", status: "completed" });
    await sleep(80);
    expect(settled).toBe(1);
    rt.runtime.closeNow("test over");
  });

  test("interrupt stops the TURN and keeps the runtime (F2) — flag set, next turn clears it", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-int");
    const feed = rt.runtime.beginTurn("run-1");
    const consumed = collect(feed);
    const outcome = await interruptSessionRuntime("sess-int");
    expect(outcome).toBe("interrupted");
    expect(rt.runtime.closed).toBe(false);
    expect(rt.runtime.interruptedTurn).toBe(true);
    // The CLI then ends the turn at its own aborted result, as measured
    // (rewind probe (e)) — and the runtime accepts the next turn.
    rt.emit(result);
    await consumed;
    const feed2 = rt.runtime.beginTurn("run-2");
    expect(rt.runtime.interruptedTurn).toBe(false);
    rt.emit(result);
    await collect(feed2);
    rt.runtime.closeNow("test done");
  });

  test("a receipt with still_queued input ESCALATES to the kill — phantom turns are not 'stopped'", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-esc");
    rt.setInterrupt(async () => ({ still_queued: ["u-1"] }));
    void collect(rt.runtime.beginTurn("run-1")).catch(() => {});
    expect(await interruptSessionRuntime("sess-esc")).toBe("escalated");
    expect(rt.runtime.closed).toBe(true);
  });

  test("an interrupt that throws escalates the same way", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-throw");
    rt.setInterrupt(async () => {
      throw new Error("no such control request");
    });
    void collect(rt.runtime.beginTurn("run-1")).catch(() => {});
    expect(await interruptSessionRuntime("sess-throw")).toBe("escalated");
    expect(rt.runtime.closed).toBe(true);
  });

  test("no active turn → no-runtime: the presence line's Stop must reach the kill, not a no-op interrupt", async () => {
    const rt = makeRuntime();
    rt.runtime.adoptSession("sess-idle");
    expect(await interruptSessionRuntime("sess-idle")).toBe("no-runtime");
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test done");
  });

  test("deleting a chat closes its runtime — teardown precedes deletion", () => {
    // The leak this pins against (creative-run find, verified): DELETE
    // /api/chats/[id] removed the chat's files and nothing else, so a session
    // deleted while its persistent runtime was live — mid-turn or hosting
    // background agents between turns — kept a warm process running and
    // writing into logs for a chat that no longer existed. The route must
    // stop the run and close the runtime BEFORE deleteChat, the same pair
    // /api/chat/stop uses.
    const src = readFileSync(
      new URL("../../app/api/chats/[id]/route.ts", import.meta.url),
      "utf8",
    );
    const stopAt = src.indexOf('stopChatRun(id, "api/chats/delete")');
    const closeAt = src.indexOf("closeSessionRuntime(id)");
    const deleteAt = src.indexOf("deleteChat(id)");
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(stopAt);
    expect(deleteAt).toBeGreaterThan(closeAt);
  });

  test("a pump error surfaces on the attached turn's consumer, like the old direct for-await", async () => {
    const errQuery = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        await tick();
        throw new Error("subprocess died");
      },
    } as unknown as Query;
    const { runtime } = acquireSessionRuntime({
      key: `err-${++keyCounter}`,
      fingerprint: "fp-err",
      create: () => errQuery,
    });
    const feed = runtime.beginTurn("run-err");
    let thrown: unknown = null;
    try {
      await collect(feed);
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("subprocess died");
  });
});
