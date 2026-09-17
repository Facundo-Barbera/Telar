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
 * THE CEILING IS LOAD-BEARING, not tidiness: this paragraph is resent on every
 * lap of every turn, so a sentence added here is paid for thousands of times.
 * Adding a rule means taking the words from somewhere.
 */
test("the briefing stays under its stated ceiling", () => {
  expect(AGENT_BRIEFING.length).toBeLessThan(2_800);
});

/** Nothing was dropped to make room — every limit the paragraph held, it holds. */
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
    "recall searches",
    "github_status reads",
    "PRESERVE WORK AND RESPECT PERMISSIONS",
    "ask them",
  ]) {
    expect(AGENT_BRIEFING).toContain(rule);
  }
});
