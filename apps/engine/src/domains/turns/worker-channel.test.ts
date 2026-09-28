import { expect, test } from "bun:test";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("stopBackgroundTasks ends lingering background work and queues the real kill", () => {
  /**
   * THE "N tasks still working" CHIP. A background task outlives its turn, so
   * there is no turn to stop; this verb marks it `stopped` in the projection
   * (the roster is right at once) and queues the actual process kill for the
   * worker to drain off the heartbeat.
   */
  const { store } = readyStore();
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Tail" });
  const claim = store.claims.claimNextTurn("worker_one")!;
  const token = claim.turn.claim!.token;
  store.turnLifecycle.markRunning("session_one", "run_one", token);
  store.ingest.ingestObservations("session_one", "run_one", token, [
    {
      kind: "task.started",
      task: { id: "task_b", kind: "background", state: "running", title: "Tail the log", providerTaskId: "bqo5yo8lm" },
    },
  ]);
  store.turnLifecycle.completeTurn("session_one", "run_one", token, { text: "started" });

  // The task lingers past its completed turn — this is the feature.
  expect(store.queries.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "running" });

  const stopped = store.worker.stopBackgroundTasks("session_one");
  expect(stopped).toBe(1);
  expect(store.queries.tasks("session_one").find((t) => t.id === "task_b")).toMatchObject({ state: "stopped" });

  // The real kill is queued for the worker — by PROVIDER id, the handle the
  // live CLI process knows the task by.
  const queued = store.sessionTasks.stopsForWorker("worker_one");
  expect(queued.map(({ sessionId, providerTaskId }) => ({ sessionId, providerTaskId }))).toEqual([{ sessionId: "session_one", providerTaskId: "bqo5yo8lm" }]);
  // Acknowledged, it is not delivered again.
  expect(store.sessionTasks.stopsForWorker("worker_one", queued.map((stop) => stop.deliveryId!))).toEqual([]);
});
