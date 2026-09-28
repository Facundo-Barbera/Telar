import { expect, test } from "bun:test";
import { useTempStores } from "../../../test/temp-store";

const { readyStore } = useTempStores();

test("the event cursor is the last journal id", () => {
  const { store } = readyStore();
  expect(store.eventCursor("session_one")).toBe(1); // session.created
  store.intake.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  store.turnLifecycle.stopTurn("session_one", "run_one");
  expect(store.eventCursor("session_one")).toBe(store.readEvents("session_one").at(-1)!.id);
});
