import { afterEach, describe, expect, test } from "bun:test";
import { worktreeReady } from "../../../../test/worktree-ready";
import { call, cleanUp, engine, orchestrator, wall, withModelCatalogue } from "./test-helpers";

afterEach(cleanUp);

type Worker = { title: string; id?: string; runId?: string; model?: string; error?: string };

describe("sessions_create with tasks", () => {
  test("one call creates each worker, tasks it, and subscribes the caller to all of them as one cohort", async () => {
    const { store, projectId } = engine();
    withModelCatalogue(store);
    const { parent, tools } = orchestrator(store, projectId);
    const created = await call(tools, "sessions_create", {
      projectId,
      envMode: "local",
      tasks: [
        { title: "port the parser", task: "Port the parser to the new AST." },
        { title: "review the diff", task: "Review the parser diff.", model: "claude-sonnet-5", effort: "high" },
      ],
    });

    expect(created.isError).toBe(false);
    const workers = created.json!.workers as Worker[];
    expect(workers.map((worker) => worker.title)).toEqual(["port the parser", "review the diff"]);
    expect(workers[1]!.model).toBe("claude-sonnet-5 at high");
    for (const [index, worker] of workers.entries()) {
      const turns = store.queries.turns(worker.id!);
      expect(turns.map((turn) => ({ runId: turn.runId, intent: turn.agentIntent, sender: turn.sender }))).toEqual([
        { runId: worker.runId!, intent: "task", sender: { sessionId: parent.id } },
      ]);
      expect(turns[0]!.input).toBe(["Port the parser to the new AST.", "Review the parser diff."][index]!);
      expect(store.records.get(worker.id!).title).toBe(worker.title);
    }
    const [cohort] = store.subscriptions.cohortsFor(parent.id);
    expect(cohort!.id).toBe((created.json!.cohort as { id: string }).id);
    expect(cohort!.members.map((member) => member.sessionId)).toEqual(workers.map((worker) => worker.id!));
    expect(String(created.json!.note)).toContain("End your turn now");
  });

  test("a worker that cannot be created is named, and the rest still start and are subscribed", async () => {
    const { store, projectId } = engine();
    withModelCatalogue(store);
    const { parent, tools } = orchestrator(store, projectId);
    const created = await call(tools, "sessions_create", {
      projectId,
      envMode: "local",
      tasks: [
        { title: "good", task: "Do the good thing." },
        { title: "bad", task: "Do it on a model nobody offers.", model: "gpt-9" },
      ],
    });

    const workers = created.json!.workers as Worker[];
    expect(workers[0]!.runId).toBeDefined();
    expect(workers[1]!.id).toBeUndefined();
    expect(workers[1]!.error).toContain('"gpt-9" is not a model claude offers');
    expect(store.subscriptions.cohortsFor(parent.id)[0]!.members.map((member) => member.sessionId)).toEqual([workers[0]!.id!]);
    expect(String(created.json!.note)).toContain("1 of 2 did not start");
  });

  test("tasks with any single-worker argument is refused, and nothing is created", async () => {
    const { store, projectId } = engine();
    const { tools } = orchestrator(store, projectId);
    const before = store.live.all().sessions.length;
    for (const extra of [{ title: "x" }, { task: "x" }, { wait: 30 }, { model: "sonnet" }]) {
      const refused = await call(tools, "sessions_create", { projectId, envMode: "local", tasks: [{ title: "a", task: "b" }], ...extra });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(`drop ${Object.keys(extra)[0]}`);
    }
    expect(store.live.all().sessions.length).toBe(before);
  });

  test("a caller that is not a session gets its workers tasked, and is told it is not subscribed", async () => {
    const { store, projectId } = engine();
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local", tasks: [{ title: "a", task: "Do a." }] });

    expect(created.json!.cohort).toBeUndefined();
    expect((created.json!.workers as Worker[])[0]!.runId).toBeDefined();
    expect(String(created.json!.note)).toContain("not subscribed");
  });
});

describe("sessions_create without envMode", () => {
  test("a local project's workers share its checkout, and a worktree project's get their own", async () => {
    for (const mode of ["local", "worktree"] as const) {
      const { store, projectId } = engine();
      store.projectRegistry.update(projectId, { envMode: mode });
      const one = await call(wall(store), "sessions_create", { projectId });
      const many = await call(wall(store), "sessions_create", { projectId, tasks: [{ title: "a", task: "Do a." }] });
      const ids = [one.json!.id as string, (many.json!.workers as Worker[])[0]!.id!];
      for (const id of ids) {
        expect(store.records.get(id).workspace.mode).toBe(mode);
        if (mode === "worktree") await worktreeReady(store, id);
      }
    }
  });

  test("an explicit envMode wins over the project's", async () => {
    const { store, projectId } = engine();
    store.projectRegistry.update(projectId, { envMode: "worktree" });
    const created = await call(wall(store), "sessions_create", { projectId, envMode: "local" });
    expect(store.records.get(created.json!.id as string).workspace.mode).toBe("local");
  });
});
