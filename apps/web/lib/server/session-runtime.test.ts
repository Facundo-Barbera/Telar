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
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { acquireSessionRuntime, closeSessionRuntime } from "./session-runtime";

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

  const query = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (out.length) yield out.shift() as SDKMessage;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  } as unknown as Query;

  return { query, emit, finish, emitted };
}

let keyCounter = 0;
function makeRuntime(opts?: { fingerprint?: string; key?: string; settleLingerMs?: number }) {
  const fq = fakeQuery();
  const key = opts?.key ?? `test-run-${++keyCounter}`;
  const { runtime, created } = acquireSessionRuntime({
    key,
    fingerprint: opts?.fingerprint ?? "fp-1",
    settleLingerMs: opts?.settleLingerMs ?? 20,
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

  test("detached traffic reaches the window sink, and the roster emptying settles it once", async () => {
    const rt = makeRuntime();
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
    rt.emit(assistant); // the background agent keeps talking
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
    const rt = makeRuntime({ settleLingerMs: 40 });
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
