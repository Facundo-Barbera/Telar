import { expect, test } from "bun:test";
import { EngineEvent, Item, TurnObservation } from "../protocol";

const artifact = { id: "chart-1", kind: "html", title: "Chart", attachmentId: "att_1", version: 2 } as const;

test("an artifact item survives the journal round trip unchanged", () => {
  const item: Item = { id: "artifact_chart-1_v2", runId: "run_1", sessionId: "session_1", status: "completed", title: "Chart", detail: { type: "artifact", artifact }, startedAt: 1, completedAt: 1 };
  const event: EngineEvent = { id: 7, at: 1, sessionId: "session_1", runId: "run_1", type: "item.completed", item };
  expect(EngineEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  expect(Item.parse(item)).toEqual(item);
});

test("a worker publishes an artifact without a version, and a bad kind or id is refused", () => {
  const { version: _version, ...published } = artifact;
  expect(TurnObservation.parse({ kind: "artifact.published", artifact: published })).toEqual({ kind: "artifact.published", artifact: published });
  expect(TurnObservation.safeParse({ kind: "artifact.published", artifact: { ...published, kind: "pdf" } }).success).toBe(false);
  expect(TurnObservation.safeParse({ kind: "artifact.published", artifact: { ...published, id: "../x" } }).success).toBe(false);
});
