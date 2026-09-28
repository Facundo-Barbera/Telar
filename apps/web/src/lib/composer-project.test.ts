// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { composerProject } from "./composer-project";

const project = (id: string, createdAt: number) => ({ id, createdAt });
const session = (projectId: string | undefined, updatedAt: number) => (projectId === undefined ? { updatedAt } : { projectId, updatedAt });

describe("composerProject", () => {
  test("opens the project owning the most recently touched session", () => {
    const projects = [project("old", 1), project("recent", 2)];
    const sessions = [session("old", 500), session("recent", 900), session("old", 100)];
    expect(composerProject(projects, sessions)).toBe("recent");
  });

  test("a project with no active session does not win on registration order alone", () => {
    // `recent` was registered last but has nothing going on; `busy` does.
    const projects = [project("busy", 1), project("recent", 99)];
    expect(composerProject(projects, [session("busy", 400)])).toBe("busy");
  });

  test("every project cold falls back to the most recently registered", () => {
    const projects = [project("first", 10), project("second", 20), project("third", 15)];
    expect(composerProject(projects, [])).toBe("second");
  });

  test("an ARCHIVED-ONLY project reads as cold — the deliberate behaviour change", () => {
    // `liveSessions` omits archived sessions, so `finished` falls to registration order.
    const projects = [project("finished", 5), project("fresh", 50)];
    const activeOnly: { projectId?: string; updatedAt: number }[] = []; // `finished`'s sessions are archived; none are reported
    expect(composerProject(projects, activeOnly)).toBe("fresh");
  });

  test("an active session anywhere still outranks the registry order", () => {
    const projects = [project("finished", 5), project("fresh", 50)];
    expect(composerProject(projects, [session("finished", 1)])).toBe("finished");
  });

  test("a session whose project is not registered cannot choose the destination", () => {
    const projects = [project("kept", 7), project("newer", 8)];
    expect(composerProject(projects, [session("gone", 9_999), session(undefined, 9_999)])).toBe("newer");
  });
});
