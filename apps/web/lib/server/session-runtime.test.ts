// THE TURN-END POLICY IS THE FIX (#28), so it is what these tests pin: a turn
// feed ends at result-with-no-background-tasks, stays open while tasks are
// live and talking, quiet-graces past a silent holder WITHOUT closing the
// runtime, and messages with no turn attached are consumed — never able to
// block the pump — while the input channel stays open for the next turn. The
// query is faked; every behaviour here is host-side policy, not SDK behaviour.

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
function makeRuntime(opts?: { quietGraceMs?: number; fingerprint?: string; key?: string }) {
  const fq = fakeQuery();
  const key = opts?.key ?? `test-run-${++keyCounter}`;
  const { runtime, created } = acquireSessionRuntime({
    key,
    fingerprint: opts?.fingerprint ?? "fp-1",
    quietGraceMs: opts?.quietGraceMs ?? 40,
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

  test("live background tasks hold the feed open past the result until they settle", async () => {
    const rt = makeRuntime();
    const feed = rt.runtime.beginTurn("run-1");
    rt.emit(tasksChanged(1));
    rt.emit(result);
    rt.emit(assistant); // post-result traffic from the background agent
    rt.emit(tasksChanged(0)); // it settles → feed may now close
    const seen = await collect(feed);
    expect(seen.length).toBe(4);
    expect(rt.runtime.closed).toBe(false);
    rt.runtime.closeNow("test over");
  });

  test("a silent background holder quiet-graces the FEED closed but leaves the RUNTIME alive", async () => {
    const rt = makeRuntime({ quietGraceMs: 30 });
    const feed = rt.runtime.beginTurn("run-1");
    rt.emit(tasksChanged(1)); // a parked dev server
    rt.emit(result);
    const seen = await collect(feed); // returns only once the grace fires
    expect(seen.length).toBe(2);
    expect(rt.runtime.turnActive).toBe(false);
    expect(rt.runtime.closed).toBe(false);
    // Late traffic is consumed and counted, never able to wedge the pump.
    rt.emit(assistant);
    await tick();
    expect(rt.runtime.detachedMessages).toBe(1);
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
