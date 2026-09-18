/**
 * THE BRIEFING'S LANGUAGE RULE IS LOAD-BEARING (owner, 2026-09-17).
 *
 * The Agent answered in voseo after the person said "vos" once. The rule it had
 * written into its own preferences lost to the model's default register; the
 * one in the briefing must not, so this pins that it is there, early, and
 * names the forms it excludes — "be neutral" alone is what fails.
 */
import { expect, test } from "bun:test";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { collectAgentTools } from "../src/agent/tools";
import { AGENT_SELF_ID } from "../src/agent/identity";
import type { SessionsCapability } from "../src/sessions-tools/tools";
import type { NotesCapability } from "../src/notes-tools/tools";
import type { AgentFleetCapability, AgentQueryCapability } from "../src/agent/tools";
import type { Session, Turn } from "@telar/engine-client";

const noSessions = (): SessionsCapability => ({
  self: { sessionId: AGENT_SELF_ID },
  list: async () => ({ sessions: [], projects: [] }),
  create: async () => ({}) as Session,
  send: async () => ({ turn: {} as Turn, replayed: false }),
  read: async () => [],
  status: async () => ({ session: {} as Session, turns: [] }),
  stop: async () => ({ stopped: 0 }) as never,
  settle: async () => ({}) as Session,
  diff: async () => ({}) as never,
  subscribe: async () => ({}) as never,
  unsubscribe: async () => false,
  subscriptions: async () => [],
  requests: async () => [],
  resolveRequest: async () => ({}) as never,
});

const noNotes = (): NotesCapability => ({
  projects: async () => [],
  list: async () => [],
  read: async () => null,
  create: async () => ({}) as never,
  update: async () => null,
  remove: async () => false,
});

const noQueries = (): AgentQueryCapability => ({
  find: async () => ({ sessions: [], index: "like", more: false }),
  outline: async () => ({ turns: [], total: 0, more: false }),
  answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
});

/** An empty fleet. These tests read DESCRIPTIONS, never call anything. */
const noFleet = (): AgentFleetCapability => ({
  rail: async () => ({ sessions: [], projects: [] }),
  subscribed: async () => [],
  who: () => undefined,
  session: async () => undefined,
  lastTurn: async () => undefined,
  openRequests: async () => 0,
  unread: () => ({}),
  since: () => undefined,
});

test("the briefing tells the Agent to answer in the person's language, in neutral Spanish", () => {
  const rule = AGENT_BRIEFING.indexOf("ANSWER IN THE LANGUAGE THE PERSON USED");
  expect(rule).toBeGreaterThan(-1);
  // Second sentence, not buried: before the role's first limit.
  expect(rule).toBeLessThan(AGENT_BRIEFING.indexOf("YOU ARE NOT A SESSION"));
  for (const excluded of ["voseo", "vos", "querés", "decime", "acá"]) expect(AGENT_BRIEFING).toContain(excluded);
  expect(AGENT_BRIEFING).toContain("tú");
});

/**
 * AND SO IS HOW IT SPENDS ITS LAPS (#570). One call per message is how "how are
 * things" became sixteen sequential tool calls and no answer; the engine now
 * runs a message's calls together, and this is the sentence that makes a model
 * put them in one message in the first place.
 */
test("the briefing tells the Agent to batch independent reads", () => {
  expect(AGENT_BRIEFING).toContain("INDEPENDENT READS GO IN ONE MESSAGE");
  expect(AGENT_BRIEFING).toContain("not one per lap");
});

/**
 * AND ANSWERING IS THE DEFAULT, LOOKING THE EXCEPTION (#601).
 *
 * This REPLACES #570's "for 'how are things' call fleet_status ONCE" in the same
 * slot, and the reversal is the point. #570 asked the right question — which
 * call is a status question — and answered it with a call, because sixteen was
 * the bug in front of it. #601 measured the next layer: the digest has ALREADY
 * been rendered into the prompt by the time the person's message arrives, so the
 * cheapest correct number for a check-in is zero. #570's "one call, not sixteen"
 * survives where a model reads it while deciding — see the test below.
 */
test("the briefing makes answering the default and looking the exception", () => {
  expect(AGENT_BRIEFING).toContain("ANSWER BEFORE YOU LOOK");
  // BOTH HALVES OF THE PROMPT, because the digest reports transitions and a
  // session working RIGHT NOW has no row in it — "who is on what" is the half
  // that carries in-flight work. A rule naming only the digest would point at a
  // block that cannot answer "what is running".
  expect(AGENT_BRIEFING).toContain("the digest and your notes are the news");
  // ABSENCE IS NEWS. `renderDigest` returns undefined when nothing is unread, so
  // no block means nothing happened — a model reading that as "I was told
  // nothing" would go looking, which is the same bug through the other door.
  expect(AGENT_BRIEFING).toContain("no digest means nothing happened");
  // The question the issue is about, by name, and what it costs.
  expect(AGENT_BRIEFING).toContain("'how are things' costs NO call");
  // AND THE EXCEPTION SURVIVES WHOLE. Not a cap: a ceiling on tool calls would
  // produce confident answers built on nothing the day a read was needed.
  expect(AGENT_BRIEFING).toContain("read only for what they cannot carry");
});

/**
 * THE CEILING IS LOAD-BEARING, not tidiness: this paragraph is resent on every
 * lap of every turn, so a sentence added here is paid for thousands of times.
 * Adding a rule means taking the words from somewhere.
 */
test("the briefing stays under its stated ceiling", () => {
  expect(AGENT_BRIEFING.length).toBeLessThan(2_800);
});

/**
 * AND WHEN LOOKING IS FINISHED (#592). Asked to wake a session and say where
 * things stood, the Agent spent 22 calls surveying thirteen sessions and took
 * no action at all. `LOOK BEFORE YOU CREATE` had no other half: nothing said
 * that the reads are there to FIND a target, or what to do when more than one
 * survives.
 */
test("the briefing says when the looking is over and the acting starts", () => {
  expect(AGENT_BRIEFING).toContain("WHEN THEY ASKED FOR AN ACTION");
  expect(AGENT_BRIEFING).toContain("once it is found, act");
  // ONE QUESTION, NOT A WIDER SEARCH — the half that keeps an ambiguous target
  // from becoming thirteen reads.
  expect(AGENT_BRIEFING).toContain("ask which rather than widening the search");
});

/**
 * EVERY LIMIT THE PARAGRAPH HELD, IT HOLDS.
 *
 * `github_status reads` LEFT THIS LIST IN #592, and deliberately: it was the
 * only entry that was not a limit but a DESCRIPTION OF A TOOL, and the tool's
 * own description is bound beside this paragraph on every lap already. Room for
 * the acting rule had to come from somewhere, and a duplicate is the only thing
 * in here whose removal costs nothing. See `briefing.ts`'s header.
 *
 * `recall searches` LEFT IT IN #601 ON THE IDENTICAL ARGUMENT — it was the last
 * remaining entry that described a tool instead of naming a limit. What replaced
 * it in this list is the rule that made the room necessary.
 */
test("trimming for room kept every rule that was there", () => {
  for (const rule of [
    "YOU ARE NOT A SESSION",
    "YOU HOLD THE SESSIONS WALL AND THE NOTES WALL",
    "LOOK BEFORE YOU CREATE",
    "DELEGATE ONLY WHAT WAS ASKED FOR",
    "SUBSCRIBE ONLY TO WORK YOU ASSIGNED",
    "REPORT WHAT CHANGED",
    "SOME CALLS WAIT FOR THE PERSON",
    "KEEP YOUR OWN NOTES WITH remember",
    "ANSWER BEFORE YOU LOOK",
    "PRESERVE WORK AND RESPECT PERMISSIONS",
    "ask them",
  ]) {
    expect(AGENT_BRIEFING).toContain(rule);
  }
});

/** What was retired is still said where a model actually reads it. */
test("the retired sentence's content survives in the tool's own description", () => {
  expect(AGENT_BRIEFING).not.toContain("github_status");
  const github = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    github: { issue: async () => ({ unavailable: "not_found" }), pull: async () => ({ unavailable: "not_found" }), projects: async () => [] },
  }).find((tool) => tool.name === "github_status")!;
  expect(github.description).toContain("issue or pull request by number");
  expect(github.description).toContain("checks");
  expect(github.description).toContain("last comment");
  // Including the half the briefing's sentence was really carrying.
  expect(github.description).toContain("Read-only");
});

/**
 * AND SO DOES #601'S — `recall`'s sentence, clause for clause.
 *
 * It said: "recall searches this conversation's own history, folded turns
 * included, for the words rather than the gist." Every one of those three
 * clauses is in the tool's own description or in its `q` parameter, both bound
 * beside the paragraph on every lap of every turn. Retiring it removed a second
 * copy, not a fact.
 */
test("the recall sentence retired for #601 survives in recall's own schema", () => {
  expect(AGENT_BRIEFING).not.toContain("recall searches");
  const recall = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    memory: { remember: () => ({ sections: {} }), recall: () => [] },
  }).find((tool) => tool.name === "recall")!;
  expect(recall.description).toContain("THIS conversation's own history");
  expect(recall.description).toContain("already folded out of your prompt");
  // "for the words rather than the gist", in the parameter that decides it.
  expect(String(recall.shape.q.description)).toContain("Lexical, not semantic");
});

/**
 * AND #570'S ROUTING SURVIVED ITS SENTENCE BEING REPLACED.
 *
 * "For 'how are things' call fleet_status ONCE" could not stay — it instructed a
 * call for the exact question #601 says costs none. But the finding underneath
 * it is still true the day a status question DOES need a look, so it has to be
 * somewhere, and the tool's own description is where a model reads it at the
 * moment it is deciding. This pins that it is there, with the new half beside
 * it: what live state is FOR, and that confirming the digest is not it.
 */
test("the replaced fleet_status sentence's routing lives in the tool's description", () => {
  expect(AGENT_BRIEFING).not.toContain("fleet_status");
  const fleet = collectAgentTools({
    sessions: noSessions(),
    notes: noNotes(),
    query: noQueries(),
    fleet: noFleet(),
  }).find((tool) => tool.name === "fleet_status")!;
  // #570's finding, in its own words: one call, not sixteen assembled by hand.
  expect(fleet.description).toContain("ONE call answers 'how is it going'");
  expect(fleet.description).toContain("sessions_answer is for one turn's words");
  // #601's half, at the moment of choosing the call.
  expect(fleet.description).toContain("NOT to confirm the digest");
  // AND IT NO LONGER OPENS BY QUOTING THE CHECK-IN BACK. "How are things across
  // every session you are on" is the phrase "¿cómo vamos?" matches against, and
  // a description that led with it invited the ritual this issue measured.
  expect(fleet.description.startsWith("Live state")).toBe(true);
  expect(fleet.description).not.toContain("How are things across");
});
