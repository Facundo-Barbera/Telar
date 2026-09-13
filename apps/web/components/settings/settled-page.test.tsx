// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@telar/engine-client";
import { searchSettings } from "@/lib/settings-search";
import { SETTINGS_SEARCH_INDEX } from "./settings-registry";
import { SettledPage, settledRows } from "./settled-page";

/**
 * SETTLED IS DERIVED, so the thing to get right is the derivation: this pane
 * cannot ask the engine which sessions are shelved, and a pane that answered
 * differently from the rail would be two shelves.
 */
const source = readFileSync(new URL("./settled-page.tsx", import.meta.url), "utf8");

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "session_a",
    projectId: "project_a",
    title: "Rewrite the settling rule",
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - 10 * HOUR,
    state: "active",
    driver: "claude",
    workspace: { mode: "local", path: "/code/telar" },
    activity: "idle",
    ...patch,
  } as Session;
}

const PROJECTS = [{ id: "project_a", name: "Telar" }];
const options = { now: NOW, autoSettleAfterHours: 3 };

test("a session settled by hand and one shelved by the clock both appear, and say which", () => {
  const rows = settledRows(
    [session({ id: "session_pinned", settledOverride: "settled", updatedAt: NOW - 60_000 }), session({ id: "session_quiet" })],
    PROJECTS,
    options,
  );
  expect(rows.map((row) => row.session.id)).toEqual(["session_pinned", "session_quiet"]);
  expect(rows.map((row) => row.byHand)).toEqual([true, false]);
});

test("a session waiting on a human is never on the shelf, however it was pinned", () => {
  // The rule's whole safety property: the worst outcome of a settling system is
  // hiding the one conversation that needed you.
  const rows = settledRows([session({ settledOverride: "settled", activity: "blocked" })], PROJECTS, options);
  expect(rows).toEqual([]);
});

test("with the clock off, only what somebody settled is shelved", () => {
  const off = { now: NOW, autoSettleAfterHours: null };
  expect(settledRows([session({ id: "session_quiet" })], PROJECTS, off)).toEqual([]);
  expect(settledRows([session({ id: "session_pinned", settledOverride: "settled" })], PROJECTS, off)).toHaveLength(1);
});

test("newest first, so the shelf answers what you just finished", () => {
  const rows = settledRows(
    [
      session({ id: "session_old", settledOverride: "settled", settledAt: NOW - 40 * HOUR }),
      session({ id: "session_new", settledOverride: "settled", settledAt: NOW - HOUR }),
    ],
    PROJECTS,
    options,
  );
  expect(rows.map((row) => row.session.id)).toEqual(["session_new", "session_old"]);
});

test("the project's name rides along, because a title alone does not place it", () => {
  const rows = settledRows([session({ settledOverride: "settled" })], PROJECTS, options);
  expect(rows[0]?.session.projectName).toBe("Telar");
});

test("the empty state is an ordinary row, not a hero", () => {
  // Server render, so nothing has loaded — the first paint, where a centred
  // illustration would be a different shape from the populated pane.
  const html = renderToStaticMarkup(<SettledPage />);
  expect(html).toContain("Settled sessions");
  expect(html).not.toContain("<img");
});

test("restore is the rail's own restore, not a second opinion about the word", () => {
  /**
   * A session shelved by the CLOCK has no override to clear, so a single
   * clearing patch writes nothing and the row is re-shelved on the next render.
   * `session-row.tsx` solves that with two patches; this pane must not solve it
   * differently, or the same button means two things in two places.
   */
  expect(source).toContain('if (!row.byHand) await api.updateSession(row.session.id, { settledOverride: "active" });');
  expect(source).toContain("await api.updateSession(row.session.id, { settledOverride: null })");
});

test("search finds the shelf by the word the reference uses for it", () => {
  const first = (query: string) => searchSettings(SETTINGS_SEARCH_INDEX, query)[0];
  expect(first("shelf")?.pageId).toBe("settled");
  expect(first("unsettle")?.pageId).toBe("settled");
  expect(first("settled sessions")?.pageLabel).toBe("Settled");
  // "archive" is the reference's word and Telar's Settling row legitimately
  // uses it too, so this pane has to be FOUND by it rather than to win it.
  expect(searchSettings(SETTINGS_SEARCH_INDEX, "archive").map((hit) => hit.pageId)).toContain("settled");
});
