// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { sessionsForSelectedProject } from "./project-selection";

test("project selection never displays a prior project's sessions while the new request is pending", () => {
  const sessions = [{ id: "session_old", projectId: "project_old" }] as never[];
  expect(sessionsForSelectedProject(sessions, "project_new", "project_old")).toEqual([]);
  expect(sessionsForSelectedProject(sessions, "project_old", "project_old")).toEqual(sessions);
});
