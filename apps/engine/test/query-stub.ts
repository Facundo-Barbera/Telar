/**
 * THE QUERY PORT, ANSWERING NOTHING — the fixture six test files needed.
 *
 * #516 made `SessionsCapability.query` a required member, so every stub wall in
 * this suite has to supply one, and most of them do not care what it answers:
 * they are asking what the Agent's tool LIST is, or what a briefing says, or how
 * a prefix caches. One empty implementation for all of them, rather than six
 * copies that could drift into disagreeing about what "answers nothing" is.
 *
 * A test that cares about a query's behaviour spreads this and replaces the one
 * member it is about — see `agent-tools.test.ts`, which is where the behaviour
 * is actually pinned.
 */
import type { SessionsQueryCapability } from "../src/sessions-tools/query";

export const noQueries = (): SessionsQueryCapability => ({
  find: async () => ({ sessions: [], index: "like", more: false }),
  outline: async () => ({ turns: [], total: 0, more: false }),
  answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
  steps: async () => ({ items: [] }),
  step: async () => ({ index: 0, id: "item_1", title: "", status: "completed", startedAt: 1, text: "", totalChars: 0, more: false }),
  grep: async () => ({ matches: [], more: false }),
});
