import { afterEach, expect, test } from "bun:test";
import type { TurnDriver } from "../drivers";
import { eventually } from "../../test/wait";
import { setup, teardown } from "../../test/worker-daemon";

afterEach(teardown);

test("a wake-up between turns becomes a PROVIDER TURN on the engine, with its tool call decided under its own claim", async () => {
  // Driver (between turns) → session door → openProviderTurn → a running turn →
  // its tool request under its own claim → its rows → completeTurn.
  let door: Parameters<TurnDriver["run"]>[0]["session"] | undefined;
  const driver: TurnDriver = {
    async run({ session }) {
      door = session;
      return { text: "first" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_one", input: "Watch CI" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
  expect(door).toBeDefined();

  // The shell ends between turns: no claim, no turn.
  await door!.onTasks([{ kind: "task.started", task: { id: "task_toolu_bg", kind: "background", state: "running", title: "Wait for CI" } }]);
  // (a start for a row nobody opened is dropped — see reportSessionTasks)
  expect((await client.session(sessionId)).tasks).toHaveLength(0);

  // The CLI wakes the model; the driver asks for a turn.
  const binding = await door!.onProviderTurn({ input: "Background task completed (green).", reason: { kind: "task_notification", taskId: "task_toolu_bg" } });
  expect(binding).toBeDefined();
  const snapshot = await client.session(sessionId);
  const providerTurn = snapshot.turns.find((turn) => turn.runId === binding!.runId);
  expect(providerTurn).toMatchObject({ state: "running", origin: "provider", input: "Background task completed (green)." });
  expect(snapshot.session.activity).toBe("working");

  // Its tool call is asked under ITS claim — and auto-accepted by the
  // session's default mode, exactly as a human turn's would be.
  const decision = await binding!.onRequest!({ kind: "file_read", detail: { kind: "file_read", read: { path: "/tmp/x" } }, toolUseId: "toolu_read" });
  expect(typeof decision === "string" ? decision : decision.decision).toBe("accept");
  await binding!.onObservations([
    { kind: "item.started", item: { id: "i_wake", detail: { type: "assistant_message", text: "merging" } } },
    { kind: "item.completed", itemId: "i_wake", status: "completed" },
  ]);
  await binding!.close({ text: "merged" });
  await eventually(async () => {
    const after = await client.session(sessionId);
    expect(after.turns.find((turn) => turn.runId === binding!.runId)).toMatchObject({ state: "completed", resultText: "merged" });
    expect(after.session.activity).toBe("idle");
  });
  const events = (await client.events(sessionId)).events.filter((event) => event.runId === binding!.runId).map((event) => event.type);
  expect(events).toEqual(["turn.accepted", "turn.claimed", "turn.started", "request.opened", "request.resolved", "item.started", "item.completed", "turn.completed"]);
});

test("sessions_send from a turn the CLI started on its own is proven by THAT turn's claim, not the settled one its capability was built in (#297)", async () => {
  // `sessionsCapability` outlives the turn that built it, so it reads the
  // worker's current claim at call time.
  let sessions: Parameters<TurnDriver["run"]>[0]["sessions"] | undefined;
  let door: Parameters<TurnDriver["run"]>[0]["session"] | undefined;
  const driver: TurnDriver = {
    async run(input) {
      sessions = input.sessions;
      door = input.session;
      return { text: "handed out the tasks" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const peer = (await client.createSession({ id: "session_two", projectId: "project_one" })).session;
  await client.submitTurn(sessionId, { runId: "run_one", input: "Coordinate" });
  await worker.tick();
  await eventually(async () => expect((await client.session(sessionId)).turns[0]?.state).toBe("completed"));
  expect(sessions).toBeDefined();

  // BETWEEN TURNS there is nothing live to send from, and the refusal says so
  // rather than blaming the token — see `requireSenderClaim`.
  await expect(sessions!.send(peer.id, { runId: "run_orphan", input: "brief" })).rejects.toThrow(/no live turn to send from/);

  // The CLI wakes up and the engine opens a real turn for it.
  const binding = await door!.onProviderTurn({ input: "Background task completed (green).", reason: { kind: "unknown" } });
  expect(binding).toBeDefined();

  // The SAME capability object — the one the wall is holding — now sends from
  // the live turn, attributed to this session and sourced to that run.
  const { turn } = await sessions!.send(peer.id, { runId: "run_brief", input: "your brief", intent: "task" });
  expect(turn).toMatchObject({ origin: "session", sender: { sessionId }, agentSourceRunId: binding!.runId });
  const delivered = (await client.session(peer.id)).turns.find((candidate) => candidate.runId === "run_brief");
  expect(delivered).toMatchObject({ input: "your brief", agentIntent: "task", sender: { sessionId } });
  await binding!.close({ text: "done" });
});

test("a message submitted mid-turn lands in the driver's mailbox and goes steered", async () => {
  // The driver plays a long turn: it waits for a steered message, drains it,
  // and answers with what it heard — proof the text crossed submit → heartbeat
  // → mailbox → driver, and that the ack settled the steered turn.
  const driver: TurnDriver = {
    async run({ steer }) {
      await steer!.wake();
      return { text: `heard:${steer!.drain().map((message) => message.text).join("|")}` };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  await client.submitTurn(sessionId, { runId: "run_live", input: "Long task" });
  await worker.tick();
  await eventually(async () => {
    expect((await client.session(sessionId)).turns.find((turn) => turn.runId === "run_live")?.state).toBe("running");
  });

  // No "Send now": submitting while the turn runs IS the steer.
  const accepted = await client.submitTurn(sessionId, { runId: "run_next", input: "Also do this" });
  expect(accepted.turn.state).toBe("steering");
  // The next heartbeat carries the delivery; the driver hears it and finishes.
  await worker.tick();
  await eventually(async () => {
    const turns = (await client.session(sessionId)).turns;
    expect(turns.find((turn) => turn.runId === "run_live")).toMatchObject({ state: "completed", resultText: "heard:Also do this" });
    expect(turns.find((turn) => turn.runId === "run_next")?.state).toBe("steered");
  });
});

test("a wake landing on an IDLE subscriber reaches the provider exactly as a steered one does (#194)", async () => {
  // No turn is in flight, so the wake's words come from `framedTurnInput`
  // instead of the steer path; the two must agree.
  const prompts: string[] = [];
  const driver: TurnDriver = {
    async run({ prompt }) {
      prompts.push(prompt);
      return { text: "ok" };
    },
  };
  const { client, sessionId, worker } = await setup(driver);
  const child = await client.createSession({ id: "session_two", projectId: "project_one", title: "the worker" });
  await client.subscribe(sessionId, { targetSessionId: child.session.id, events: ["turn_completed"] });

  // The host is IDLE throughout — nothing to steer into.
  await client.submitTurn(child.session.id, { runId: "run_child", input: "child work" });
  await worker.tick();
  await eventually(async () => {
    const wake = (await client.session(sessionId)).turns.find((turn) => turn.origin === "session");
    expect(wake).toBeDefined();
  });
  await worker.tick();

  await eventually(() => {
    expect(prompts.some((prompt) => prompt.startsWith("[wake: completed]"))).toBe(true);
  });
  const delivered = prompts.find((prompt) => prompt.startsWith("[wake: completed]"))!;
  expect(delivered).toContain(child.session.id);
  // Not wrapped in a frame: the notification says whose words these are.
  expect(delivered).not.toContain("[engine wake · ");
  // The child's own prompt was handed over bare — a person's words never had a frame.
  expect(prompts).toContain("child work");
});

test("a heartbeat WITHOUT a steer key still parses — the forward-compat default", async () => {
  // An older engine sends no steer array; the schema's .default([]) is what
  // keeps a newer worker from failing every heartbeat against it. Pinned at
  // the schema, where the guarantee lives.
  const { WorkerStatus } = await import("@telar/engine-client");
  const parsed = WorkerStatus.parse({ workerId: "worker_one", heartbeatAt: 1, cancel: [], resolved: [] });
  expect(parsed.steer).toEqual([]);
});
