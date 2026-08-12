// Story 4.2 / AC8 — the authoring reference's proof.
//
// Two claims that cannot be made by reading: that all FIVE required subjects are
// present, and that the reference's own worked example WOULD ACTUALLY BE
// ACCEPTED by the tool it teaches. A reference whose own example the gate would
// reject is worse than no reference, and this file is the only way to know.
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig can't resolve it — suppress just the import, the same
// idiom `spend-readout.test.ts` and `ultra-wake.test.ts` carry.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { compileScript } from "@telar/core";
import { ULTRA_AUTHORING_REFERENCE } from "./ultra-authoring";

// The five subjects, by STABLE MARKER — the section headings, which are what a
// reader navigates by and what a rewrite would have to keep. Four come from
// `SPEC.md` CAP-3; the fifth ("no servers") comes from `epics.md`'s § Story 4.2
// dispatch note and is named nowhere else in the planning artifacts.
const SUBJECTS = [
  ["the injected surface API (CAP-3)", "### The injected surface"],
  ["the explicit-model rule (CAP-3)", "### The explicit-model rule"],
  ["the quality patterns (CAP-3)", "### Quality patterns"],
  ["one worked example (CAP-3)", "### A worked example"],
  ["no servers / no long-lived processes (the dispatch note's fifth)", "### No servers, no long-lived processes"],
] as const;

describe("4.2 AC8 — the authoring reference covers all five required subjects", () => {
  for (const [subject, marker] of SUBJECTS) {
    test(`it covers ${subject}`, () => {
      expect(ULTRA_AUTHORING_REFERENCE).toContain(marker);
    });
  }

  test("the two quality-pattern NAMES survive, verbatim, because this story deletes their only other home", () => {
    // `SPEC.md` CAP-3 enumerates them: "the quality patterns
    // (adversarial-verify, loop-until-dry)". Before story 4.2 these two strings
    // appeared in exactly ONE production string — the paragraph of
    // `ULTRA_TOOL_DESCRIPTION` this story removes. Without them here, the story
    // would REMOVE two named patterns from the product rather than relocate
    // them.
    expect(ULTRA_AUTHORING_REFERENCE).toContain("loop-until-dry");
    expect(ULTRA_AUTHORING_REFERENCE).toContain("adversarial-verify");
  });

  test("it names the surface members a script actually receives", () => {
    for (const member of ["agent(", "parallel(", "pipeline(", "phase(", "log(", "args"]) {
      expect(ULTRA_AUTHORING_REFERENCE).toContain(member);
    }
  });

  test("it is a NON-TRIVIAL string — a floor, so an emptied constant cannot pass the markers above", () => {
    expect(ULTRA_AUTHORING_REFERENCE.length).toBeGreaterThan(2000);
  });
});

// ── the worked example, fed to the real gate ────────────────────────────────

/** Pull the indented code block out of the reference and dedent it. Extracting
 *  rather than duplicating is the point: a test with its own copy of the example
 *  proves that copy compiles and says nothing at all about the one the model
 *  reads. */
function workedExample(): string {
  const start = ULTRA_AUTHORING_REFERENCE.indexOf("### A worked example");
  const end = ULTRA_AUTHORING_REFERENCE.indexOf("Note what it does NOT do");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return ULTRA_AUTHORING_REFERENCE.slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("    "))
    .map((l) => l.slice(4))
    .join("\n");
}

describe("4.2 AC8 proof 4 — the worked example compiles under the real static gate", () => {
  test("the extractor found a real script, not an empty string", () => {
    // Anti-vacuity for the extractor itself: a marker rename would otherwise
    // hand `compileScript("")` to the assertions below, and an empty script
    // fails for the wrong reason — or, under the stub described next, passes.
    const src = workedExample();
    expect(src.length).toBeGreaterThan(300);
    expect(src).toContain("export const meta");
    expect(src).toContain("export default async function");
  });

  test("THE DISCRIMINATOR — a model-less variant of the SAME example is REJECTED", () => {
    // WHY THIS TEST EXISTS AND WHY IT COMES FIRST. Measured at `e093a98`:
    // `apps/web/lib/ultra-mcp.test.ts` installs a process-global
    // `mock.module("@telar/core", …)` AT MODULE SCOPE whose `compileScript`
    // returns a canned value initialised to `{ ok: true, … }`, restored only in
    // `afterAll`. Under the filtered run shape hard rule 6 mandates
    // (`bun test apps/web -t "…"`), every file's module scope evaluates before
    // any test runs and no `afterAll` fires — so that stub is LIVE inside this
    // file and the positive assertion below would be satisfied by a stub that
    // says yes to everything.
    //
    // A guard that cannot fail is worse than no guard (maxim 3). So: feed the
    // real gate something it MUST reject. If this comes back `ok: true`, the
    // positive result means NOTHING and the failure text says so.
    const modelless = workedExample().replace(/\{ model: "sonnet", label: f \}/, "{ label: f }");
    expect(modelless).not.toBe(workedExample()); // the replacement actually landed
    const rejected = compileScript(modelless);
    if (rejected.ok) {
      throw new Error(
        "AC8 proof 4 IS VACUOUS IN THIS RUN. compileScript accepted a model-less script, which the " +
          "real gate rejects (sandbox.ts's lintMissingModel). That means a process-global " +
          'mock.module("@telar/core", …) — ultra-mcp.test.ts installs one at module scope and ' +
          "restores it only in afterAll — is stubbing compileScript here, so the positive assertion " +
          "below proves nothing. Re-run this file ALONE (`bun test apps/web/lib/ultra-authoring.test.ts`); " +
          "that verdict is the fact. The leak is story 1.3's and is not this story's to repair.",
      );
    }
    expect(rejected.ok).toBe(false);
    expect(typeof rejected.kind).toBe("string");
    expect(rejected.kind.length).toBeGreaterThan(0);
  });

  test("the second discriminator — a non-literal `meta` is rejected too", () => {
    const bad = workedExample().replace("export const meta = {", "export const meta = buildMeta({");
    const rejected = compileScript(bad);
    expect(rejected.ok).toBe(false);
  });

  test("THE POSITIVE — the example as written compiles, and every agent() call names a model", () => {
    const result = compileScript(workedExample());
    if (!result.ok) {
      throw new Error(
        `The authoring reference's own worked example does not compile: ${result.error} ` +
          `(kind=${result.kind}, line=${result.line}). A reference whose example the tool would ` +
          `reject is worse than no reference — fix the example in lib/ultra-authoring.ts.`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.meta).toMatchObject({ name: "rank-files" });
    // Every `agent(` call site in the example carries a model. `lintMissingModel`
    // already proves this (it is what the discriminator above exercises), but
    // asserting it here names the property CAP-3 actually requires.
    const src = workedExample();
    expect(src.match(/\bagent\(/g)?.length).toBe(2);
    expect(src.match(/model:/g)?.length).toBe(2);
  });
});
