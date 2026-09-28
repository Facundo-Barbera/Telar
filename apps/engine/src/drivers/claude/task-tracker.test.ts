import { expect, test } from "bun:test";
import { createClaudeDriver, run } from "../../../test/claude-harness";

// ── sub-agents ───────────────────────────────────────────────────────────────

test("a Task call becomes a HANDLE row, not a generic tool row", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "Audit the parser", subagent_type: "Explore" } }],
        },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.find((o) => o.kind === "item.started");
  // items.ts: "the row is a handle; the detail is on the task events". The id
  // is derived from the tool_use id, which is what every message inside the
  // sub-agent will independently produce from its `parent_tool_use_id`.
  expect(started?.kind === "item.started" && started.item.detail).toEqual({ type: "task", taskId: "task_toolu_task" });
  expect(started?.kind === "item.started" && started.item.title).toBe("Audit the parser");
});

test("a sub-agent's work is FILED under its task and never becomes the turn's answer", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_task", description: "Audit the parser", subagent_type: "Explore" };
      // The child's own tool call and its own prose, both carrying the id of
      // the Task call that launched them.
      yield {
        type: "assistant",
        parent_tool_use_id: "toolu_task",
        message: { content: [{ type: "tool_use", id: "toolu_child", name: "Bash", input: { command: "rg parser" } }] },
      };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "child says" } } };
      yield { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_stop", index: 0 } };
      // The main loop's own answer.
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "parent says" } } };
      yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_task", status: "completed", summary: "found it", output_file: "/tmp/x" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);

  // THE HEADLINE ASSERTION. With `forwardSubagentText` on, a sub-agent's prose
  // arrives as an ordinary assistant message; appending it would make a
  // fan-out's turn summary the concatenation of every agent talking at once.
  await expect(result).resolves.toMatchObject({ text: "parent says" });

  const started = sink.observations.filter((o) => o.kind === "item.started");
  const child = started.find((o) => o.kind === "item.started" && o.item.id === "item_toolu_child");
  expect(child?.kind === "item.started" && child.item.taskId).toBe("task_toolu_task");
  // Both agents opened content block index 0. Keyed by index alone they would
  // be one row, and the parent's deltas would land on the child's item.
  const textRows = started.filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
  expect(textRows).toHaveLength(2);
  expect(new Set(textRows.map((o) => (o.kind === "item.started" ? o.item.taskId : undefined)))).toEqual(
    new Set(["task_toolu_task", undefined]),
  );
});

test("task lifecycle rides the stream, and a partial patch does not erase the title", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_task", description: "Audit the parser", subagent_type: "Explore", task_type: "subagent" };
      // Observed against the real SDK: progress repeats the description with a
      // "Running " prefix. Taking it as the title makes a roster row read as
      // status prose and churn while the agent works.
      yield { type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "toolu_task", description: "Running Audit the parser", usage: { total_tokens: 40, tool_uses: 2, duration_ms: 9 } };
      // `task_updated` carries a PATCH naming only what changed — no title, no
      // kind. A straight replace would blank both.
      yield { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "completed" } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;

  const tasks = sink.observations.filter((o) => o.kind.startsWith("task."));
  expect(tasks.map((o) => o.kind)).toEqual(["task.started", "task.progress", "task.completed"]);
  const [opened, progressed, closed] = tasks;
  expect(progressed?.kind === "task.progress" && progressed.task.title).toBe("Audit the parser");
  expect(progressed?.kind === "task.progress" && progressed.task.usage?.tokens.output).toBe(40);
  expect(opened?.kind === "task.started" && opened.task).toMatchObject({
    id: "task_toolu_task",
    kind: "agent",
    state: "running",
    title: "Audit the parser",
    role: "Explore",
    providerTaskId: "t1",
  });
  // Folded onto what was already known, and joined back to the same contract id
  // even though this message carried no tool_use_id at all.
  expect(closed?.kind === "task.completed" && closed.task).toMatchObject({
    id: "task_toolu_task",
    state: "completed",
    title: "Audit the parser",
    role: "Explore",
  });
});

test("an agent still running when the turn ends is failed, so the session stops claiming it is busy", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "never reports back" };
      yield { type: "system", subtype: "task_started", task_id: "t2", tool_use_id: "toolu_b", description: "a log tail", task_type: "background_shell" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  // The agent is closed; the BACKGROUND task is not — outliving its turn is
  // the definition of background, and `livenessOf` reports it as monitoring.
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task.id).toBe("task_toolu_a");
  expect(closed[0]?.kind === "task.completed" && closed[0].task.state).toBe("failed");
});

test("a shell that blocks its turn is a tool call, not a task row — until Ctrl+B makes it one", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "fg1", tool_use_id: "toolu_fg", description: "bun test", task_type: "local_bash" };
      yield { type: "system", subtype: "task_progress", task_id: "fg1", description: "Running bun test" };
      yield { type: "system", subtype: "task_notification", task_id: "fg1", status: "completed", summary: "done" };
      // A second blocking shell, sent to the background mid-flight (Ctrl+B):
      // from that frame on it is background work and earns a row.
      yield { type: "system", subtype: "task_started", task_id: "fg2", tool_use_id: "toolu_fg2", description: "tail -f dev.log", task_type: "local_bash" };
      yield { type: "system", subtype: "task_updated", task_id: "fg2", patch: { is_backgrounded: true } };
      yield { type: "system", subtype: "task_progress", task_id: "fg2", summary: "line 1" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const tasks = sink.observations.filter((o) => o.kind === "task.started" || o.kind === "task.progress" || o.kind === "task.completed");
  expect(tasks.map((o) => o.kind === "task.started" || o.kind === "task.progress" || o.kind === "task.completed" ? o.task.id : "")).toEqual([
    "task_fg2",
    "task_fg2",
  ]);
  expect(tasks[0]?.kind === "task.progress" && tasks[0].task).toMatchObject({ kind: "background", backgrounded: true, state: "running" });
});

test("a sub-agent launched in the BACKGROUND outlives its turn, and stays an agent", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "t1",
        tool_use_id: "toolu_a",
        description: "Explore the connection model",
        subagent_type: "Explore",
        task_type: "local_agent",
        is_backgrounded: true,
      };
      // A foreground agent sent to the background mid-flight (Ctrl+B) keeps
      // its kind and gains the flag.
      yield { type: "system", subtype: "task_started", task_id: "t2", tool_use_id: "toolu_b", description: "Audit the parser", task_type: "local_agent" };
      yield { type: "system", subtype: "task_updated", task_id: "t2", patch: { is_backgrounded: true } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.find((o) => o.kind === "task.started");
  expect(started?.kind === "task.started" && started.task).toMatchObject({ kind: "agent", backgrounded: true, role: "Explore" });
  const moved = sink.observations.filter((o) => o.kind === "task.progress").at(-1);
  expect(moved?.kind === "task.progress" && moved.task).toMatchObject({ id: "task_toolu_b", kind: "agent", backgrounded: true });
  // Neither is swept: nothing completed, nothing failed.
  expect(sink.observations.filter((o) => o.kind === "task.completed")).toHaveLength(0);
});

test("a background task missing from the SDK's level signal is closed, so a lost bookend cannot wedge the session", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "b8t21ys02", tool_use_id: "toolu_mon", description: "tick test", task_type: "local_bash", is_backgrounded: true };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b8t21ys02", task_type: "local_bash", description: "tick test" }] };
      // The monitor's stream ends. The notification that should bookend it is
      // LOST — only the membership change says anything.
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task).toMatchObject({
    id: "task_toolu_mon",
    kind: "background",
    state: "completed",
  });
  // No failure (nothing went wrong) and no invented summary (the notification
  // that carried it may simply have been lost — fabricating one would lie).
  expect(closed[0]?.kind === "task.completed" && closed[0].task.failure).toBeUndefined();
  expect(closed[0]?.kind === "task.completed" && closed[0].task.resultText).toBeUndefined();
});

test("a background task still in the level signal outlives the turn untouched", async () => {
  // The guard against over-closing: membership PRESENT means the work is
  // live, and outliving its turn is the definition of background.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "a log tail", task_type: "local_bash", is_backgrounded: true };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "a log tail" }] };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  expect(sink.observations.filter((o) => o.kind === "task.completed")).toHaveLength(0);
});

test("the level signal closes only background work; a missing agent is the turn-end sweep's business", async () => {
  // An agent is by definition absent from a BACKGROUND membership list, so
  // reading its absence as an ending would close every live sub-agent the
  // moment any shell started or stopped.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "Audit the parser", task_type: "subagent" };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  // Exactly one closure, and it is the SWEEP's (failed at turn end) — the
  // level signal contributed nothing.
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task).toMatchObject({
    id: "task_toolu_a",
    state: "failed",
    failure: "the turn ended before this agent reported back",
  });
});

test("a BACKGROUNDED agent missing from the level signal is closed, and its late failure still lands", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_a1", description: "Explore", task_type: "local_agent", is_backgrounded: true };
      yield { type: "system", subtype: "task_started", task_id: "a2", tool_use_id: "toolu_a2", description: "Audit", task_type: "local_agent", is_backgrounded: true };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Explore" }, { task_id: "a2", task_type: "local_agent", description: "Audit" }] };
      // Both end. a1's notification is LOST; a2's arrives after the level and
      // says it failed.
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "system", subtype: "task_notification", task_id: "a2", tool_use_id: "toolu_a2", status: "failed", summary: "rate limited" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const last = new Map(
    sink.observations.flatMap((o) => (o.kind === "task.completed" ? [[o.task.id, o.task] as const] : [])),
  );
  expect(last.get("task_toolu_a1")).toMatchObject({ kind: "agent", state: "completed" });
  expect(last.get("task_toolu_a2")).toMatchObject({ kind: "agent", state: "failed", resultText: "rate limited" });
});

test("the level REPLACES the live set: a task dropped from a later list is healed even when that list was about something else", async () => {
  // Not "the list went empty": a second task starting is the membership
  // change that reveals the first one's lost ending.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "s1", tool_use_id: "toolu_s1", description: "tail the log", task_type: "local_bash", is_backgrounded: true };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "s1", task_type: "local_bash", description: "tail the log" }] };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Explore" }] };
      yield { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_a1", description: "Explore", task_type: "local_agent", is_backgrounded: true };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.flatMap((o) => (o.kind === "task.completed" ? [o.task.id] : []));
  expect(closed).toEqual(["task_toolu_s1"]);
  // The entry that arrived before its bookend minted nothing of its own: the
  // one row is keyed on the tool_use id its sub-agent's items are filed under.
  const rows = new Set(sink.observations.flatMap((o) => (o.kind.startsWith("task.") && "task" in o ? [o.task.id] : [])));
  expect(rows).toEqual(new Set(["task_toolu_s1", "task_toolu_a1"]));
});

test("an entry the level lists is background work, even when the patch saying so was lost", async () => {
  // A foreground agent sent to the background: the level lists it, and the
  // `task_updated{is_backgrounded}` edge never arrives. Without the level the
  // turn-end sweep failed a live agent.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "toolu_a1", description: "Audit", task_type: "local_agent" };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "Audit" }] };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  expect(sink.observations.filter((o) => o.kind === "task.completed")).toHaveLength(0);
  const last = sink.observations.filter((o) => o.kind === "task.progress").at(-1);
  expect(last?.kind === "task.progress" && last.task).toMatchObject({ id: "task_toolu_a1", kind: "agent", backgrounded: true, state: "running" });
});

test("the level's ambient flag is carried onto a live row, both ways", async () => {
  // The SDK re-sends the level when "an entry's `ambient` flag flips". The row
  // stays; it just stops (and then resumes) counting as activity.
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "w1", tool_use_id: "toolu_w1", description: "watch files", task_type: "local_bash", is_backgrounded: true };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w1", task_type: "local_bash", description: "watch files", ambient: true }] };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w1", task_type: "local_bash", description: "watch files" }] };
      // An ambient entry with no row stays out: its edges cannot mint one.
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w1", task_type: "local_bash", description: "watch files" }, { task_id: "amb", task_type: "local_bash", description: "housekeeping", ambient: true }] };
      yield { type: "system", subtype: "task_progress", task_id: "amb", description: "housekeeping" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const flags = sink.observations.flatMap((o) => (o.kind === "task.progress" ? [o.task.ambient] : []));
  expect(flags).toEqual([true, false]);
  expect(sink.observations.some((o) => o.kind.startsWith("task.") && "task" in o && o.task.providerTaskId === "amb")).toBe(false);
});

test("an ambient task is the CLI's housekeeping and never becomes a row", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "amb1", description: "live-update watcher", task_type: "local_bash", is_backgrounded: true, ambient: true, skip_transcript: true };
      yield { type: "system", subtype: "task_progress", task_id: "amb1", description: "Running live-update watcher" };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "amb1", task_type: "local_bash", description: "live-update watcher", ambient: true }] };
      yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
      yield { type: "system", subtype: "task_notification", task_id: "amb1", summary: "watcher wound down" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  expect(sink.observations.filter((o) => o.kind.startsWith("task."))).toHaveLength(0);
});

test("a finished task is not resurrected by the SDK still talking about it", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "Sleep for 90 seconds in background" };
      yield { type: "system", subtype: "task_updated", task_id: "t1", patch: { status: "killed" } };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_a", summary: "Sleep for 90 seconds in background" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const reports = sink.observations.filter((o) => o.kind === "task.started" || o.kind === "task.progress" || o.kind === "task.completed");
  const states = reports.map((o) => ("task" in o ? o.task.state : undefined));
  // Never back to running, and never swept into a failure it did not have.
  expect(states).toEqual(["running", "stopped", "stopped"]);
  expect(states).not.toContain("failed");
  // The last word is still a completion event, so a client folding these ends
  // up with a settled task rather than one that reads as in flight.
  expect(reports.at(-1)?.kind).toBe("task.completed");
});

test("a notification with no status is an ENDING, because that is the only thing it can mean", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "toolu_a", description: "Audit the parser" };
      yield { type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "toolu_a", summary: "found three" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  expect(closed).toHaveLength(1);
  expect(closed[0]?.kind === "task.completed" && closed[0].task).toMatchObject({ state: "completed", resultText: "found three" });
});

test("a backgrounded shell carries its log path from the moment its Bash call returns", async () => {
  const file = "/private/tmp/claude-501/-proj/sess/tasks/bsh1.output";
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_b", name: "Bash", input: { command: "bun run dev", run_in_background: true } }] } };
      yield { type: "system", subtype: "task_started", task_id: "bsh1", tool_use_id: "toolu_b", task_type: "local_bash", description: "Dev server", is_backgrounded: true };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_b", content: `Command running in background with ID: bsh1. Output is being written to: ${file}. You will be notified when it completes.` }] },
        tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bsh1" },
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const reports = sink.observations.flatMap((o) => (o.kind === "task.started" || o.kind === "task.progress" || o.kind === "task.completed" ? [o.task] : []));
  expect(reports.at(-1)).toMatchObject({ id: "task_toolu_b", kind: "background", outputFile: file });
});

test("a result that lands before its task_started still reaches the row", async () => {
  const file = "/tmp/claude-501/-proj/sess/tasks/bsh2.output";
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "tail -f x", run_in_background: true } }] } };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_c", content: `Output is being written to: ${file}.` }] },
        tool_use_result: { backgroundTaskId: "bsh2" },
      };
      yield { type: "system", subtype: "task_started", task_id: "bsh2", tool_use_id: "toolu_c", task_type: "local_bash", description: "Tail", is_backgrounded: true };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const started = sink.observations.find((o) => o.kind === "task.started");
  expect(started?.kind === "task.started" && started.task.outputFile).toBe(file);
});

test("a shell's notification states its log; an agent's does not become one", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "bsh3", tool_use_id: "toolu_d", task_type: "local_bash", description: "Build", is_backgrounded: true };
      yield { type: "system", subtype: "task_started", task_id: "ag1", tool_use_id: "toolu_e", task_type: "local_agent", description: "Explore" };
      yield { type: "system", subtype: "task_notification", task_id: "bsh3", tool_use_id: "toolu_d", status: "completed", summary: "done", output_file: "/tmp/claude-501/p/s/tasks/bsh3.output" };
      yield { type: "system", subtype: "task_notification", task_id: "ag1", tool_use_id: "toolu_e", status: "completed", summary: "found", output_file: "/tmp/claude-501/p/s/tasks/ag1.output" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.flatMap((o) => (o.kind === "task.completed" ? [o.task] : []));
  expect(closed.find((t) => t.id === "task_toolu_d")?.outputFile).toBe("/tmp/claude-501/p/s/tasks/bsh3.output");
  expect(closed.find((t) => t.id === "task_toolu_e")?.outputFile).toBeUndefined();
});

test("a RESUMED SUB-AGENT this process never announced is not filed as a process", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      // The level signal names it: a sub-agent, running in the background.
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "agent_7", task_type: "local_agent", description: "Explore the repo" }],
      };
      // Its only edge in this process: no task_type, only the backgrounded flag.
      yield { type: "system", subtype: "task_updated", task_id: "agent_7", patch: { status: "running", is_backgrounded: true } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const rows = sink.observations.filter((o) => o.kind === "task.progress" || o.kind === "task.started");
  expect(rows).toHaveLength(1);
  const task = rows[0]?.kind === "task.progress" ? rows[0].task : undefined;
  expect(task?.kind).toBe("agent");
  // Still background WORK — it outlives the turn — just not a process.
  expect(task?.backgrounded).toBe(true);
});

test("a real backgrounded SHELL this process never announced stays a process", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "shell_3", task_type: "local_bash", description: "Start Telar dev server" }],
      };
      // The only edge this process sees, and it states no type.
      yield { type: "system", subtype: "task_notification", task_id: "shell_3", status: "completed", summary: "server exited" };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const closed = sink.observations.filter((o) => o.kind === "task.completed");
  expect(closed).toHaveLength(1);
  const task = closed[0]?.kind === "task.completed" ? closed[0].task : undefined;
  expect(task?.kind).toBe("background");
  expect(task?.resultText).toBe("server exited");
});

test("an ANNOUNCED sub-agent later moved to the background keeps being an agent", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "system", subtype: "task_started", task_id: "agent_9", tool_use_id: "toolu_a9", description: "Explore", task_type: "local_agent", subagent_type: "Explore" };
      yield { type: "system", subtype: "task_updated", task_id: "agent_9", patch: { status: "running", is_backgrounded: true } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const last = sink.observations.filter((o) => o.kind === "task.progress").at(-1);
  const task = last?.kind === "task.progress" ? last.task : undefined;
  expect(task?.kind).toBe("agent");
  expect(task?.role).toBe("Explore");
});

test("a type stated AFTER the row exists corrects the kind it was defaulted to", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      // No type stated anywhere yet.
      yield { type: "system", subtype: "task_updated", task_id: "late_1", patch: { status: "running", is_backgrounded: true } };
      // The SDK finally says what it is.
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "late_1", task_type: "local_bash", description: "Start Telar dev server" }],
      };
      yield { type: "system", subtype: "task_updated", task_id: "late_1", patch: { status: "running" } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver);
  await result;
  const rows = sink.observations.filter((o) => o.kind === "task.progress");
  const kinds = rows.map((o) => (o.kind === "task.progress" ? o.task.kind : undefined));
  // It may start out defaulted, but the statement wins and is the last word.
  expect(kinds.at(-1)).toBe("background");
  // …and the correction is announced, not merely held: the level frame itself
  // re-announces the row, so a store with no further frames still ends right.
  expect(kinds.filter((kind) => kind === "background").length).toBeGreaterThanOrEqual(2);
});

test("a SEEDED row carrying the wrong kind is corrected by the stated type", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "seeded_1", task_type: "local_agent", description: "Explore the repo" }],
      };
      yield { type: "result", subtype: "success" };
    },
  }));
  const { sink, result } = run(driver, {
    tasks: [{ id: "task_seeded_1", providerTaskId: "seeded_1", kind: "background", state: "running" }],
  });
  await result;
  const rows = sink.observations.filter((o) => o.kind === "task.progress");
  const task = rows.at(-1);
  expect(task?.kind === "task.progress" && task.task.kind).toBe("agent");
});
