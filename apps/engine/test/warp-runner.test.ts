/**
 * WHAT A WARP RUN DOES TO THE SESSION'S TASK STREAM.
 *
 * Every assertion here is about rows on that one stream, because that is the
 * whole architectural bet: the run is a `background` task, its agents are
 * `agent` tasks parented to it, and every surface — the Agents pane, the
 * directing agent's `warp_status`, the session's "still working" pill — is a
 * fold over those rows rather than a second store to keep in step.
 *
 * `spawn` is injected throughout, so none of this costs a provider, a process
 * or a token.
 */
import { expect, test } from "bun:test";
import { TaskSeed } from "@telar/engine-client";
import { compileWarpScript } from "../src/warp/sandbox";
import { createWarpRunner, type WarpSpawn } from "../src/warp/runner";

const META = `export const meta = { name: "demo", description: "a demo" };\n`;

/** Ids that read as what they are, so a failure names the row rather than a
 *  uuid. */
function ids() {
  const counts = new Map<string, number>();
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function harness(spawn: WarpSpawn, concurrency?: number) {
  const emitted: TaskSeed[] = [];
  const start = createWarpRunner({
    spawn,
    emit: (seed) => emitted.push(structuredClone(seed)),
    newId: ids(),
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  const compile = (body: string) => {
    const compiled = compileWarpScript(`${META}${body}`);
    if (!compiled.ok) throw new Error(`script did not compile: ${compiled.error}`);
    return compiled;
  };
  return { emitted, start, compile };
}

/** Every row for one task, in order — which is how a client actually sees it. */
const rowsFor = (emitted: TaskSeed[], id: string) => emitted.filter((seed) => seed.id === id).map((seed) => seed.state);

const echo: WarpSpawn = async ({ prompt }) => ({ text: `echo:${prompt}` });

test("the run is a background task and its agents are parented to it", async () => {
  /**
   * THE STRUCTURAL BET, pinned. `background` is not a borrowed shape: the
   * contract defines it as work that continues after the turn that started it
   * settles, which is a warp run exactly — so `livenessOf()` reports the session
   * as working without being taught anything about warps.
   */
  const { emitted, start, compile } = harness(echo);
  const run = start(compile(`await agent("first"); await agent("second");`), { instanceId: "claude" });
  await run.done;

  const runRow = emitted.find((seed) => seed.id === run.runId)!;
  expect(runRow.kind).toBe("background");
  expect(runRow.title).toBe("demo");

  const agentRows = emitted.filter((seed) => seed.kind === "agent");
  expect(new Set(agentRows.map((seed) => seed.parentTaskId))).toEqual(new Set([run.runId]));
  expect(agentRows.every((seed) => seed.warp?.warpRunId === run.runId)).toBe(true);
  expect(agentRows.every((seed) => seed.warp?.warpName === "demo")).toBe(true);
});

test("an agent is announced pending before it is admitted, so the queue is visible", async () => {
  // A fan-out that only appeared `concurrency` rows at a time would make the
  // pane look like it was doing less than it was asked to.
  const { emitted, start, compile } = harness(echo, 1);
  const run = start(compile(`await parallel([0,1,2].map((i) => () => agent("job " + i)));`), { instanceId: "claude" });

  const pendingBeforeAnySettles = emitted.filter((seed) => seed.kind === "agent" && seed.state === "pending");
  expect(pendingBeforeAnySettles).toHaveLength(3);

  await run.done;
  expect(rowsFor(emitted, "task_1")).toEqual(["pending", "running", "completed"]);
});

test("the linkage repeats on every row, not just the first", async () => {
  /**
   * The contract's own reason, inherited from t3 code's hard-won comment: a
   * client that joined a late row to its start row could not once the start row
   * aged out of retention, and the agent silently vanished from the roster.
   * Repetition is cheap; reconstructing identity from an absent row is not
   * possible.
   */
  const { emitted, start, compile } = harness(echo);
  const run = start(compile(`phase("Scan"); await agent("look");`), { instanceId: "claude" });
  await run.done;

  const rows = emitted.filter((seed) => seed.id === "task_1");
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.warp?.warpRunId).toBe(run.runId);
    expect(row.warp?.phaseTitle).toBe("Scan");
    expect(row.title).toBe("look");
  }
});

test("every emitted row satisfies the contract, model selection included", async () => {
  /**
   * THE TRAP THIS EXISTS FOR, and it was live until this test was written:
   * `ModelSelection` carries a refine — "must name at least one of model, effort
   * or fast mode" — so a row that named only the login FAILED validation, and
   * `ingestObservations` rejects the whole BATCH when one observation is
   * invalid. Every row of a fan-out would have vanished because one agent
   * inherited the session's model, which is the ordinary case. A unit test on
   * the runner's own shape could not have caught it; parsing with the real
   * schema does.
   */
  const { emitted, start, compile } = harness(echo);
  const run = start(
    compile(`
      await agent("inherits everything");
      await agent("names a model", { model: "claude-opus-5", effort: "high" });
    `),
    { instanceId: "claude" },
  );
  await run.done;

  for (const seed of emitted) expect(TaskSeed.safeParse(seed).success).toBe(true);

  const inherited = emitted.find((seed) => seed.title === "inherits everything")!;
  expect(inherited.model).toBeUndefined();
  const named = emitted.find((seed) => seed.title === "names a model")!;
  expect(named.model).toEqual({ instanceId: "claude", model: "claude-opus-5", effort: "high" });
});

test("a dead agent is null, and the fan-out survives it", async () => {
  // One casualty must not lose the run — `.filter(Boolean)` is the documented
  // idiom precisely because this returns null rather than throwing.
  const spawn: WarpSpawn = async ({ prompt }) => (prompt.includes("2") ? { failure: "child died" } : { text: prompt });
  const { emitted, start, compile } = harness(spawn);
  const run = start(compile(`return await parallel([1,2,3].map((i) => () => agent("job " + i)));`), { instanceId: "claude" });
  const snapshot = await run.done;

  expect(snapshot.result).toEqual(["job 1", null, "job 3"]);
  expect(snapshot.state).toBe("completed");
  const failed = emitted.filter((seed) => seed.state === "failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.failure).toBe("child died");
});

test("a thrown stage drops its item and the other items keep flowing", async () => {
  const { start, compile } = harness(echo);
  const run = start(
    compile(`
      return await pipeline([1,2,3],
        (item) => item,
        (item) => { if (item === 2) throw new Error("bad item"); return item * 10; });
    `),
    { instanceId: "claude" },
  );
  expect((await run.done).result).toEqual([10, null, 30]);
});

test("a pipeline stage sees the original item and its index, not just the last result", async () => {
  // The signature exists so a later stage can label work without stage one
  // having to thread context through its return value.
  const { start, compile } = harness(echo);
  const run = start(
    compile(`
      return await pipeline(["a","b"],
        (item) => item.toUpperCase(),
        (prev, original, index) => prev + ":" + original + ":" + index);
    `),
    { instanceId: "claude" },
  );
  expect((await run.done).result).toEqual(["A:a:0", "B:b:1"]);
});

test("concurrency is capped, and the cap is what is actually in flight", async () => {
  let live = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const spawn: WarpSpawn = async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise<void>((resolve) => release.push(resolve));
    live -= 1;
    return { text: "done" };
  };
  const { start, compile } = harness(spawn, 2);
  const run = start(compile(`return await parallel([0,1,2,3,4].map((i) => () => agent("job " + i)));`), { instanceId: "claude" });

  // Let the gate admit its first batch, then drain.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(peak).toBe(2);
  while (release.length > 0) {
    release.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await run.done;
  expect(peak).toBe(2);
});

test("stop unwinds the script instead of being swallowed as a dead agent", async () => {
  /**
   * THE CONTROL-SIGNAL CARVE-OUT. `parallel` turns an ordinary failure into
   * `null` so a fan-out survives a casualty — but a stop must NOT be swallowed,
   * or a stopped run would quietly go on to spawn its next phase.
   */
  const release: Array<() => void> = [];
  const spawn: WarpSpawn = async () => {
    await new Promise<void>((resolve) => release.push(resolve));
    return { text: "done" };
  };
  const { emitted, start, compile } = harness(spawn, 1);
  const run = start(
    compile(`
      await parallel([0,1,2].map((i) => () => agent("job " + i)));
      await agent("this must never run");
    `),
    { instanceId: "claude" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  run.stop("user pressed stop");
  release.shift()?.();
  const snapshot = await run.done;

  expect(snapshot.state).toBe("stopped");
  expect(snapshot.failure).toBe("user pressed stop");
  // The queued agents were never spawned, and the statement after the fan-out
  // never reached the gate at all.
  expect(emitted.some((seed) => seed.title === "this must never run")).toBe(false);
  expect(emitted.filter((seed) => seed.state === "stopped").length).toBeGreaterThan(0);
});

test("a live child can be steered, and a settled one refuses by name", async () => {
  /**
   * THE CHILD DRAINS AT A TURN BOUNDARY, which is the shape a real spawn has:
   * the SDK tells it a turn settled, it looks in the mailbox, and anything there
   * becomes another turn. Written first as an `AsyncIterable` the child awaited,
   * which deadlocked — the child never returned, so the runner never closed the
   * queue, so the child never returned. The mailbox makes that unexpressible.
   */
  const seen: string[] = [];
  let release!: () => void;
  const spawn: WarpSpawn = async ({ steer }) => {
    await new Promise<void>((resolve) => (release = resolve));
    // A turn just settled: take whatever arrived while it was running.
    seen.push(...steer.drain());
    return { text: "done" };
  };
  const { start, compile } = harness(spawn);
  const run = start(compile(`return await agent("long job");`), { instanceId: "claude" });

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(run.send("task_1", "focus on the parser")).toBe(true);
  // Unknown ids are refused rather than silently accepted.
  expect(run.send("task_99", "nobody home")).toBe(false);

  release();
  await run.done;
  expect(seen).toEqual(["focus on the parser"]);
  // Settled now: too late is an answer, not a silent drop.
  expect(run.send("task_1", "one more thing")).toBe(false);
});

test("the run's own row settles last, carrying the outcome", async () => {
  const { emitted, start, compile } = harness(echo);
  const run = start(compile(`await agent("only"); return "the answer";`), { instanceId: "claude" });
  await run.done;

  const last = emitted.at(-1)!;
  expect(last.id).toBe(run.runId);
  expect(last.state).toBe("completed");
  expect(last.resultText).toBe("the answer");
});

test("a script that throws fails the run rather than rejecting at the launcher", async () => {
  // The launcher ended its turn the moment it got a runId; there is nobody left
  // to catch a rejection, so a failure has to be a state.
  const { start, compile } = harness(echo);
  const run = start(compile(`throw new Error("author slipped");`), { instanceId: "claude" });
  const snapshot = await run.done;
  expect(snapshot.state).toBe("failed");
  expect(snapshot.failure).toContain("author slipped");
});

test("a phase named on the call wins over the ambient one", async () => {
  /**
   * The ambient `phase()` is a RACE inside concurrent stages — several advance
   * at once and the last writer wins — so naming it on the call is the only way
   * a row reliably lands in the box a reader expects.
   */
  const { emitted, start, compile } = harness(echo);
  const run = start(
    compile(`
      phase("Review");
      await parallel([
        () => agent("a", { phase: "Verify" }),
        () => agent("b"),
      ]);
    `),
    { instanceId: "claude" },
  );
  await run.done;
  const byTitle = new Map(emitted.filter((s) => s.kind === "agent").map((s) => [s.title, s.warp?.phaseTitle]));
  expect(byTitle.get("a")).toBe("Verify");
  expect(byTitle.get("b")).toBe("Review");
});

test("a declared phase gets its index; an undeclared one is still labelled", async () => {
  // The index is what lets a client draw the tree from meta before anything
  // finishes; a phase the script invents at runtime still deserves a name.
  const compiled = compileWarpScript(`export const meta = {
      name: "demo", description: "d", phases: [{ title: "Review" }, { title: "Verify" }],
    };
    phase("Verify"); await agent("declared");
    phase("Improvised"); await agent("undeclared");
  `);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const emitted: TaskSeed[] = [];
  const start = createWarpRunner({ spawn: echo, emit: (seed) => emitted.push(seed), newId: ids() });
  await start(compiled, { instanceId: "claude" }).done;

  const declared = emitted.find((seed) => seed.title === "declared")!;
  expect(declared.warp?.phaseIndex).toBe(1);
  const improvised = emitted.find((seed) => seed.title === "undeclared")!;
  expect(improvised.warp?.phaseTitle).toBe("Improvised");
  expect(improvised.warp?.phaseIndex).toBeUndefined();
});
