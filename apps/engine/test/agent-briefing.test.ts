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

test("the briefing stays under its stated ceiling", () => {
  expect(AGENT_BRIEFING.length).toBeLessThan(2_800);
});
