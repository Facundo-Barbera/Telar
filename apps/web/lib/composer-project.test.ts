/**
 * Which project the front door opens.
 *
 * The screen this belongs to (`app/front-door.tsx`) is the first thing the
 * desktop window loads, and it used to ask the engine for one session list PER
 * PROJECT — 1.3-2.0 s on a real store (14 projects, 114 sessions) to decide a
 * redirect. It now takes one `liveSessions` read and folds it here — in the
 * BROWSER since #407, which is why the fold lives beside this test rather than
 * inside a route.
 *
 * THAT CHANGED ONE ANSWER ON PURPOSE, and this is where that is pinned:
 * `liveSessions` reports ACTIVE sessions, so a project whose sessions are all
 * archived now scores cold instead of winning on a conversation somebody
 * finished with. The last two tests are that case.
 */
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
    /**
     * `liveSessions` never reports the archived ones, so the fold sees no
     * session for `finished` at all. Before this change the per-project read
     * counted archived sessions too, and a project nobody had touched in weeks
     * could win because its last archived conversation was newer than the
     * active work elsewhere. Now it falls to registration order.
     */
    const projects = [project("finished", 5), project("fresh", 50)];
    const activeOnly: { projectId?: string; updatedAt: number }[] = []; // `finished`'s sessions are archived; none are reported
    expect(composerProject(projects, activeOnly)).toBe("fresh");
  });

  test("an active session anywhere still outranks the registry order", () => {
    const projects = [project("finished", 5), project("fresh", 50)];
    expect(composerProject(projects, [session("finished", 1)])).toBe("finished");
  });

  test("a session whose project is not registered cannot choose the destination", () => {
    // A removed project's sessions, or another engine's, must not redirect
    // anywhere: there is no canvas to open for an id this registry lacks.
    const projects = [project("kept", 7), project("newer", 8)];
    expect(composerProject(projects, [session("gone", 9_999), session(undefined, 9_999)])).toBe("newer");
  });
});
