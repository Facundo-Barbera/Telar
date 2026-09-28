import { expect, test } from "bun:test";
import { planDetailForTodos, taskKindForType, taskStateForStatus } from "./tasks";

test("a TodoWrite whose payload is not a todo list stays an ordinary tool row", () => {
  expect(planDetailForTodos({ todos: [] })).toBeUndefined();
  expect(planDetailForTodos({ nope: 1 })).toBeUndefined();
  expect(planDetailForTodos({ todos: [{ activeForm: "Reading" }] })?.steps).toEqual([{ step: "Reading", status: "pending" }]);
});

test("task classification is a DENYLIST, so a renamed agent type is unstyled and never invisible", () => {
  expect(taskKindForType("background_shell")).toBe("background");
  expect(taskKindForType("local_bash")).toBe("background");
  expect(taskKindForType("subagent")).toBe("agent");
  expect(taskKindForType("local_workflow")).toBe("agent");
  expect(taskKindForType(undefined)).toBe("agent");
  expect(taskStateForStatus("killed")).toBe("stopped");
  expect(taskStateForStatus("paused")).toBe("waiting");
  expect(taskStateForStatus(undefined)).toBe("running");
  expect(taskStateForStatus(undefined, "completed")).toBe("completed");
  expect(taskStateForStatus("running", "completed")).toBe("running");
});
