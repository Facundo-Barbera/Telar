// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { EngineEvent, Item, Turn } from "@telar/engine-client";
import { envelope, item, turn } from "@/lib/testing/journal-fixtures";
import { projectJournal } from "./journal";
import { hostPassiveArrivals } from "./journal-arrivals";

describe("passive arrivals", () => {
  /** Passive peer turns accepted while a run was busy must not render as turns of their own. */
  const notice = (runId: string, from: string) =>
    ({
      kind: "peer_message",
      sessionId: from,
      runId,
      intent: "result",
      summary: `[agent message · result] session ${from} sent this session a result`,
      fetch: { sessionId: "s1", runId },
      body: `[agent message · result] session ${from} sent this session a result`,
    }) as NonNullable<Turn["notification"]>;
  const passive = (runId: string, sequence: number, at: number, from: string): Turn => ({
    runId,
    sessionId: "s1",
    sequence,
    input: "the peer's words",
    origin: "session",
    sender: { sessionId: from },
    agentIntent: "result",
    agentDelivery: "passive",
    notification: notice(runId, from),
    state: "completed",
    resultText: "",
    acceptedAt: at,
    updatedAt: at,
    completedAt: at,
  });
  const arrival = (runId: string, at: number): Item =>
    item({ id: `notification_${runId}`, runId, status: "completed", startedAt: at, completedAt: at, detail: { type: "notification", notification: notice(runId, "peer") } });
  const said = (id: string, at: number): Item =>
    item({ id, runId: "run_386", status: "completed", startedAt: at, completedAt: at, detail: { type: "assistant_message", text: id } });
  const host: Turn = { ...turn, runId: "run_386", sequence: 386, input: "[wake]", state: "running", acceptedAt: 100, updatedAt: 100, startedAt: 100 };
  const guests = [passive("run_392", 392, 120, "…41bed0"), passive("run_394", 394, 130, "…84af05"), passive("run_397", 397, 160, "…abefd6")];
  const rows = [said("answer_early", 110), arrival("run_392", 120), arrival("run_394", 130), said("answer_final", 150), arrival("run_397", 160)];

  test("each lands inside the running turn, in time order, above the working line", () => {
    const projected = projectJournal([host, ...guests], rows, []);
    const shown = hostPassiveArrivals(projected);
    expect(shown.map((row) => row.runId)).toEqual(["run_386"]);
    expect(shown[0]!.items.map((row) => row.id)).toEqual(["answer_early", "notification_run_392", "notification_run_394", "answer_final", "notification_run_397"]);
    expect(projected[0]!.items.map((row) => row.id)).toEqual(["answer_early", "answer_final"]);
  });

  test("and stay there once the turn is stopped and the next one begins", () => {
    const stopped: Turn = { ...host, state: "stopped", completedAt: 170 };
    const next: Turn = { ...turn, runId: "run_398", sequence: 398, input: "Hola?", state: "running", acceptedAt: 200, updatedAt: 200, startedAt: 200 };
    const shown = hostPassiveArrivals(projectJournal([stopped, ...guests, next], rows, []));
    expect(shown.map((row) => row.runId)).toEqual(["run_386", "run_398"]);
    expect(shown[0]!.items.filter((row) => row.detail.type === "notification")).toHaveLength(3);
    expect(shown[1]!.items).toEqual([]);
  });

  test("off the live tail too: the end the tail reports bounds the host", () => {
    const late = passive("run_399", 399, 180, "…f00");
    const events: EngineEvent[] = [
      { ...envelope, id: 1, at: 170, runId: "run_386", type: "turn.stopped" },
      { ...envelope, id: 2, at: 180, runId: "run_399", type: "turn.accepted", turn: { ...late, state: "queued" }, replayed: false },
      { ...envelope, id: 3, at: 180, runId: "run_399", type: "item.started", item: arrival("run_399", 180) },
      { ...envelope, id: 4, at: 180, runId: "run_399", type: "turn.completed", resultText: "" },
    ] as EngineEvent[];
    const shown = hostPassiveArrivals(projectJournal([host], [said("answer_early", 110)], events));
    expect(shown.map((row) => row.runId)).toEqual(["run_386", "run_399"]);
  });

  test("a passive arrival with no turn running, and none after it yet, stays a row", () => {
    const idle: Turn = { ...host, state: "completed", completedAt: 105 };
    expect(hostPassiveArrivals(projectJournal([idle, ...guests], rows, [])).map((row) => row.runId)).toEqual(["run_386", "run_392", "run_394", "run_397"]);
  });

  test("arrivals while idle fold into the head of the NEXT turn — the one that handed them over", () => {
    const idle: Turn = { ...host, state: "completed", completedAt: 105 };
    const next: Turn = { ...turn, runId: "run_398", sequence: 398, input: "[cohort done]", state: "running", acceptedAt: 200, updatedAt: 200, startedAt: 200 };
    const shown = hostPassiveArrivals(projectJournal([idle, ...guests, next], rows, []));
    expect(shown.map((row) => row.runId)).toEqual(["run_386", "run_398"]);
    expect(shown[1]!.items.map((row) => row.id)).toEqual(["notification_run_392", "notification_run_394", "notification_run_397"]);
  });

  test("a wake — delivered, not passive — is still a turn of its own", () => {
    const woke: Turn = { ...guests[0]!, agentDelivery: "wake" };
    expect(hostPassiveArrivals(projectJournal([host, woke], rows, [])).map((row) => row.runId)).toEqual(["run_386", "run_392"]);
  });
});
