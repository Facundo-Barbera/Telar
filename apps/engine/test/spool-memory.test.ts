/**
 * The expert's memory — what a pass may change about it, and what it may not.
 *
 * WHAT THIS SUITE PROTECTS is a failure that was live on disk. A pass used to
 * hand `writeExpertDigest` a completely fresh object, so the model rebuilt the
 * project's whole memory from scratch through the lens of whichever item it
 * happened to read. Three consequences: a fact the current item did not touch
 * evaporated silently, nothing carried provenance, and a wrong fact could only
 * be removed by hoping a later model chose not to restate it.
 *
 * The aurora digest is what forced the change. It held "Aurora has no locally
 * reachable codebase or tracker — searched thoroughly this time": an agent
 * telling its future self not to look, with no verb that could remove it.
 *
 * No provider and no daemon — the merge is a pure fold over disk.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpoolItem, SpoolMemoryFact } from "@telar/engine-client";
import {
  applyVerification,
  ensureSpool,
  factsNeedingVerification,
  mergeExpertDigest,
  readExpertDigest,
  spoolPaths,
  writeExpertDigest,
  type SpoolPaths,
} from "../src/spool/store";
import { expertPrompt } from "../src/spool/expert";
import { verifyPrompt } from "../src/spool/night";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-memory-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

const fact = (over: Partial<SpoolMemoryFact> & { id: string; text: string }): SpoolMemoryFact => ({
  kind: "howItWorks",
  source: { pass: "Fri 22:00" },
  ...over,
});

/** A digest as an earlier pass left it. */
function seed(facts: SpoolMemoryFact[], glossary: Array<{ term: string; means: string }> = []) {
  return writeExpertDigest(paths, {
    project: "ozom-gv",
    schemaVersion: 1,
    updated: "Fri 22:00",
    summary: "Where it stood on Friday.",
    methodology: "How it worked on Friday.",
    glossary,
    facts,
  });
}

/** A pass that learned and retired nothing — the shape of "I only rewrote the
 *  overview", which is the common case and the one that used to lose things. */
const quietPass = {
  at: "Sat 10:00",
  summary: "Where it stands now.",
  methodology: "How it works now.",
  glossary: [] as Array<{ term: string; means: string }>,
  facts: [] as Array<{ text: string; kind: SpoolMemoryFact["kind"] }>,
  retire: [] as Array<{ id: string; why: string }>,
};

describe("a pass folds into memory rather than replacing it", () => {
  /**
   * THE HEADLINE FIX, and the exact shape of what was broken: a pass about one
   * corner of a project must not cost the project everything learned about the
   * others.
   */
  test("a pass that learned nothing new keeps every stored fact", () => {
    seed([
      fact({ id: "f-1", text: "reconciliation.ts is auto-copied to the edge function" }),
      fact({ id: "f-2", text: "Ana tracks budget-vs-actuals", kind: "person" }),
      fact({ id: "f-3", text: "we chose BigQuery over a direct pull", kind: "decision" }),
    ]);

    mergeExpertDigest(paths, "ozom-gv", quietPass);

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts.map((f) => f.id)).toEqual(["f-1", "f-2", "f-3"]);
  });

  test("a new fact is appended, and carries the pass that wrote it", () => {
    seed([fact({ id: "f-1", text: "reconciliation.ts is auto-copied" })]);

    mergeExpertDigest(paths, "ozom-gv", {
      ...quietPass,
      facts: [{ text: "the September close is the 29th", kind: "environment" }],
    });

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts).toHaveLength(2);
    const added = after.facts.at(-1)!;
    expect(added.text).toBe("the September close is the 29th");
    expect(added.kind).toBe("environment");
    // PROVENANCE, which the old blob could not carry: every fact wore the
    // timestamp of the most recent pass, including one learned three passes ago.
    expect(added.source.pass).toBe("Sat 10:00");
    expect(added.id).not.toBe("f-1");
  });

  /** Otherwise a model restating what it was just told grows the digest every
   *  night — the one failure the wholesale rewrite did NOT have, so the fix must
   *  not introduce it. */
  test("restating a stored fact adds nothing", () => {
    seed([fact({ id: "f-1", text: "reconciliation.ts is auto-copied" })]);

    mergeExpertDigest(paths, "ozom-gv", {
      ...quietPass,
      facts: [{ text: "  Reconciliation.ts IS auto-copied  ", kind: "howItWorks" }],
    });

    expect(readExpertDigest(paths, "ozom-gv")!.facts).toHaveLength(1);
  });

  test("the overview still replaces, because an overview is correct to regenerate", () => {
    seed([]);
    mergeExpertDigest(paths, "ozom-gv", quietPass);

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.summary).toBe("Where it stands now.");
    expect(after.methodology).toBe("How it works now.");
    expect(after.updated).toBe("Sat 10:00");
  });
});

describe("the glossary merges by term", () => {
  test("a term the pass did not restate survives", () => {
    seed([], [{ term: "presupuestos", means: "Creatio order amounts" }, { term: "cierre", means: "month-end close" }]);

    mergeExpertDigest(paths, "ozom-gv", { ...quietPass, glossary: [{ term: "cierre", means: "month-end close" }] });

    expect(readExpertDigest(paths, "ozom-gv")!.glossary.map((t) => t.term)).toEqual(["presupuestos", "cierre"]);
  });

  test("a restated term is updated in place, keeping its position", () => {
    seed([], [{ term: "presupuestos", means: "budgets" }, { term: "cierre", means: "month-end close" }]);

    mergeExpertDigest(paths, "ozom-gv", {
      ...quietPass,
      glossary: [{ term: "presupuestos", means: "Creatio order amounts" }],
    });

    const glossary = readExpertDigest(paths, "ozom-gv")!.glossary;
    expect(glossary[0]).toEqual({ term: "presupuestos", means: "Creatio order amounts" });
    expect(glossary[1]!.term).toBe("cierre");
  });

  test("a term the pass invented is added", () => {
    seed([], [{ term: "cierre", means: "month-end close" }]);
    mergeExpertDigest(paths, "ozom-gv", { ...quietPass, glossary: [{ term: "PD", means: "portfolio dashboard" }] });
    expect(readExpertDigest(paths, "ozom-gv")!.glossary).toHaveLength(2);
  });
});

/**
 * RETIREMENT IS THE DRAIN VERB, not a deletion — "No deletion path. Dismissing
 * drains. Nothing here deletes." A retired fact stays readable on disk with the
 * reason it stopped being true, and is left out of every prompt.
 */
describe("retirement", () => {
  test("a retired fact is marked and kept, never removed", () => {
    seed([fact({ id: "f-1", text: "aurora has no reachable codebase — searched thoroughly", kind: "environment" })]);

    mergeExpertDigest(paths, "ozom-gv", {
      ...quietPass,
      retire: [{ id: "f-1", why: "aurora was registered; there is a checkout now" }],
    });

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts).toHaveLength(1);
    expect(after.facts[0]!.retired).toEqual({
      at: "Sat 10:00",
      why: "aurora was registered; there is a checkout now",
    });
  });

  /**
   * THE ONE AN AGENT MUST NOT TOUCH. Nobody but the user can confirm who is
   * involved and how, so an agent retiring a `person` fact is an agent settling
   * a human question. The schema asks it not to; this makes asking unnecessary,
   * because a description is not something a model can be made to obey.
   */
  test("an agent cannot retire a person fact", () => {
    seed([fact({ id: "f-1", text: "Ana tracks budget-vs-actuals", kind: "person" })]);

    mergeExpertDigest(paths, "ozom-gv", { ...quietPass, retire: [{ id: "f-1", why: "I did not see her this pass" }] });

    expect(readExpertDigest(paths, "ozom-gv")!.facts[0]!.retired).toBeUndefined();
  });

  /** Re-retiring would overwrite the reason it was first drained, losing the
   *  true one for whatever a later pass happened to say. */
  test("an already-retired fact keeps its original reason", () => {
    seed([
      fact({
        id: "f-1",
        text: "the edge copy is generated",
        retired: { at: "Fri 22:00", why: "the generator was removed" },
      }),
    ]);

    mergeExpertDigest(paths, "ozom-gv", { ...quietPass, retire: [{ id: "f-1", why: "a different reason" }] });

    expect(readExpertDigest(paths, "ozom-gv")!.facts[0]!.retired!.why).toBe("the generator was removed");
  });

  test("retiring an id that is not there changes nothing", () => {
    seed([fact({ id: "f-1", text: "a fact" })]);
    mergeExpertDigest(paths, "ozom-gv", { ...quietPass, retire: [{ id: "f-nope", why: "…" }] });
    expect(readExpertDigest(paths, "ozom-gv")!.facts[0]!.retired).toBeUndefined();
  });
});

/**
 * THE POINT OF RETIRING ONE. Until a fact could be left out of the prompt there
 * was no way to stop the aurora note telling every future pass not to look.
 */
describe("what reaches the model", () => {
  const item: SpoolItem = {
    id: "i-1",
    title: "presupuestos sept no cuadran",
    provenance: "typed",
    captured: "Fri 22:48",
    schemaVersion: 1,
    project: "ozom-gv",
  };

  test("a retired fact is on disk and absent from the prompt", () => {
    seed([
      fact({ id: "f-1", text: "LIVE-FACT" }),
      fact({ id: "f-2", text: "RETIRED-FACT", retired: { at: "Fri", why: "moved" } }),
    ]);

    const prompt = expertPrompt({ project: "ozom-gv", digest: readExpertDigest(paths, "ozom-gv"), item });

    expect(prompt).toContain("LIVE-FACT");
    expect(prompt).not.toContain("RETIRED-FACT");
    // Still readable — drained, not deleted.
    expect(readExpertDigest(paths, "ozom-gv")!.facts).toHaveLength(2);
  });

  test("every live fact is addressable, so a retirement can name one", () => {
    // A model asked to retire a fact it was shown without an id can only
    // describe one, and a retraction matched on prose hits the wrong fact the
    // first time two of them read alike.
    seed([fact({ id: "f-abc123", text: "a fact" })]);
    const prompt = expertPrompt({ project: "ozom-gv", digest: readExpertDigest(paths, "ozom-gv"), item });
    expect(prompt).toContain("f-abc123");
  });

  /** The provenance law — "every artifact an agent produced is marked as such
   *  until a human has looked at it" — is worth as much pointed at the model as
   *  at the user. */
  test("an unreviewed fact is marked as unconfirmed; a reviewed one is not", () => {
    seed([
      fact({ id: "f-1", text: "UNCHECKED-FACT" }),
      fact({ id: "f-2", text: "CONFIRMED-FACT", reviewed: true }),
    ]);

    const prompt = expertPrompt({ project: "ozom-gv", digest: readExpertDigest(paths, "ozom-gv"), item });
    const unchecked = prompt.slice(prompt.indexOf("UNCHECKED-FACT"), prompt.indexOf("CONFIRMED-FACT"));

    expect(unchecked).toContain("nobody has confirmed it");
    expect(prompt.slice(prompt.indexOf("CONFIRMED-FACT"))).not.toContain("nobody has confirmed it");
  });
});

/**
 * THE LIFT FROM `notes: string[]` — and the reason it exists is a bug the whole
 * suite was blind to.
 *
 * `SpoolExpertDigest` is a `looseObject`, so a digest written before memory was
 * addressable parses CLEANLY: `notes` survives as an unknown key and `facts`
 * takes its `[]` default. Not an unreadable digest — a readable, silently EMPTY
 * one. ozom-gv's ten notes were on disk with nothing reading them and every test
 * passed, because each seeds its own digest in the new shape.
 *
 * Driving it is what found that. These make sure it stays found.
 */
describe("a digest written before facts existed", () => {
  /** Written by hand rather than through `writeExpertDigest`, because the new
   *  writer cannot produce the old shape — which is the whole point. */
  function seedLegacy(notes: unknown) {
    fs.mkdirSync(path.join(paths.experts, "ozom-gv"), { recursive: true });
    fs.writeFileSync(
      path.join(paths.experts, "ozom-gv", "digest.json"),
      JSON.stringify({
        project: "ozom-gv",
        schemaVersion: 1,
        updated: "Fri 22:50",
        summary: "s",
        methodology: "m",
        glossary: [],
        notes,
      }),
    );
  }

  test("its notes are lifted into facts rather than silently dropped", () => {
    seedLegacy(["reconciliation.ts is auto-copied", "Ana tracks budget-vs-actuals"]);

    const digest = readExpertDigest(paths, "ozom-gv")!;

    expect(digest.facts.map((f) => f.text)).toEqual([
      "reconciliation.ts is auto-copied",
      "Ana tracks budget-vs-actuals",
    ]);
  });

  /** `howItWorks` is the SAFE guess, not the common one: it is the kind an agent
   *  MAY retire. Guessing `person` would make a wrong lifted note permanent
   *  unless a human went looking for it. */
  test("a lifted note is retirable from both doors, and marked unconfirmed", () => {
    seedLegacy(["aurora has no reachable codebase — searched thoroughly"]);

    const [fact] = readExpertDigest(paths, "ozom-gv")!.facts;

    expect(fact!.kind).toBe("howItWorks");
    expect(fact!.reviewed).toBeUndefined();
    expect(fact!.source.pass).toBe("Fri 22:50");
  });

  /** An id that changed between reads could never be retired — the retirement
   *  would name a fact that no longer goes by that name. */
  test("ids are stable across reads", () => {
    seedLegacy(["one", "two"]);
    const first = readExpertDigest(paths, "ozom-gv")!.facts.map((f) => f.id);
    const second = readExpertDigest(paths, "ozom-gv")!.facts.map((f) => f.id);
    expect(second).toEqual(first);
  });

  test("a lifted note can then be retired, and the lift does not run again", () => {
    seedLegacy(["a stale note"]);
    const [fact] = readExpertDigest(paths, "ozom-gv")!.facts;

    mergeExpertDigest(paths, "ozom-gv", {
      at: "Sat 10:00",
      summary: "s",
      methodology: "m",
      glossary: [],
      facts: [],
      retire: [{ id: fact!.id, why: "the file moved" }],
    });

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts).toHaveLength(1);
    expect(after.facts[0]!.retired!.why).toBe("the file moved");
  });

  test("a digest that already has facts is left alone", () => {
    seed([fact({ id: "f-1", text: "a real fact" })]);
    // A hand-edited file could hold both; the new shape wins and nothing is
    // lifted on top of it.
    expect(readExpertDigest(paths, "ozom-gv")!.facts.map((f) => f.id)).toEqual(["f-1"]);
  });

  test("junk in the old key does not throw", () => {
    seedLegacy("not an array");
    expect(readExpertDigest(paths, "ozom-gv")!.facts).toEqual([]);
    seedLegacy([42, "", "  ", "kept"]);
    expect(readExpertDigest(paths, "ozom-gv")!.facts.map((f) => f.text)).toEqual(["kept"]);
  });
});

/**
 * THE `verify` JOB — the only maintenance the night performs, and the reason it
 * is allowed to be a night job at all.
 *
 * "Go learn more about the project" has no stopping condition. This does: it
 * selects facts not checked against the current commit and stamps them with
 * that commit, so its own output falsifies its predicate. That property is
 * asserted here rather than described, because losing it turns the night into
 * exactly the thing its header says it cannot be.
 */
describe("what a verification selects", () => {
  const HEAD = "abc123def456";

  test("only `howItWorks`, and only what this commit has not seen", () => {
    seed([
      fact({ id: "f-1", text: "the edge copy is generated" }),
      fact({ id: "f-2", text: "already checked", verifiedAt: HEAD }),
      fact({ id: "f-3", text: "Ana tracks budget-vs-actuals", kind: "person" }),
      fact({ id: "f-4", text: "we chose BigQuery", kind: "decision" }),
      fact({ id: "f-5", text: "aurora is unreachable", kind: "environment" }),
      fact({ id: "f-6", text: "drained", retired: { at: "Fri", why: "moved" } }),
    ]);

    const stale = factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD);

    /**
     * A `person` fact is not checkable against a tree and is not an agent's to
     * judge. A `decision` is a record no file can contradict. An `environment`
     * fact is a CACHE whose truth is the machine's right now, not the
     * repository's — it needs an expiry, not a diff.
     */
    expect(stale.map((f) => f.id)).toEqual(["f-1"]);
  });

  test("a fact checked at a DIFFERENT commit is selected again", () => {
    seed([fact({ id: "f-1", text: "the edge copy is generated", verifiedAt: "oldsha" })]);
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD).map((f) => f.id)).toEqual(["f-1"]);
  });

  /** A `rev-parse` that failed returns "". Stamping facts as "checked at
   *  nothing" would mark them verified against a commit that does not exist and
   *  suppress the next real check. */
  test("with no commit at all, nothing is selected", () => {
    seed([fact({ id: "f-1", text: "a fact" })]);
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), "")).toEqual([]);
  });
});

describe("what a verification writes", () => {
  const HEAD = "abc123def456";
  const at = "Sat 11:00";

  test("what holds is stamped; what does not is drained with its reason", () => {
    seed([
      fact({ id: "f-1", text: "still true" }),
      fact({ id: "f-2", text: "the edge copy is generated" }),
    ]);

    const applied = applyVerification(paths, "ozom-gv", {
      at,
      head: HEAD,
      checked: [
        { id: "f-1", holds: true },
        { id: "f-2", holds: false, why: "build:edge-core was removed in favour of a symlink" },
      ],
    });

    expect(applied).toEqual({ verified: 1, retired: 1 });
    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts[0]!.verifiedAt).toBe(HEAD);
    expect(after.facts[1]!.retired!.why).toBe("build:edge-core was removed in favour of a symlink");
    // Drained, never removed.
    expect(after.facts).toHaveLength(2);
  });

  /**
   * THE PROPERTY THAT MAKES IT A NIGHT JOB. Run it twice on an unchanged tree
   * and the second run has nothing to select. Without this the night could
   * schedule the same maintenance forever.
   */
  test("its own output falsifies its predicate", () => {
    seed([fact({ id: "f-1", text: "a checkable claim" })]);
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD)).toHaveLength(1);

    applyVerification(paths, "ozom-gv", { at, head: HEAD, checked: [{ id: "f-1", holds: true }] });

    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD)).toEqual([]);
  });

  /**
   * THE CASE EVERY FIXTURE WAS SHAPED TO MISS, and a live run found.
   *
   * The prompt tells the model to stay silent about anything it could not check
   * — "not finding something is not evidence against it". The first real run
   * reported on 6 of 10 facts and drained 1, leaving 3 UNMENTIONED. Stamping
   * only what was named would have left those 3 selected forever: every night
   * re-running this job, re-reading the repository, re-spending the money, and
   * learning nothing.
   *
   * So `verifiedAt` means EXAMINED AND NOT CONTRADICTED. A fact the model went
   * looking at and could say nothing against has been examined.
   */
  test("a fact the model did not mention is still marked examined", () => {
    seed([
      fact({ id: "f-1", text: "reported on" }),
      fact({ id: "f-2", text: "could not be checked, so left unmentioned" }),
      fact({ id: "f-3", text: "also unmentioned" }),
    ]);

    const applied = applyVerification(paths, "ozom-gv", {
      at,
      head: HEAD,
      checked: [{ id: "f-1", holds: true }],
    });

    expect(applied).toEqual({ verified: 3, retired: 0 });
    // AND THE PREDICATE IS EMPTY — which is the property, not the count.
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD)).toEqual([]);
  });

  test("a moved tree selects them all again", () => {
    seed([fact({ id: "f-1", text: "a claim" }), fact({ id: "f-2", text: "another" })]);
    applyVerification(paths, "ozom-gv", { at, head: HEAD, checked: [] });
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), HEAD)).toEqual([]);
    // A new commit is a new question.
    expect(factsNeedingVerification(readExpertDigest(paths, "ozom-gv"), "newsha")).toHaveLength(2);
  });

  /** The job may drain; it may not rewrite. An agent quietly editing what a
   *  project believes, with no record of the edit, is what the provenance
   *  apparatus exists to prevent. */
  test("it never changes a fact's text", () => {
    seed([fact({ id: "f-1", text: "the original wording" })]);
    applyVerification(paths, "ozom-gv", { at, head: HEAD, checked: [{ id: "f-1", holds: false, why: "wrong" }] });
    expect(readExpertDigest(paths, "ozom-gv")!.facts[0]!.text).toBe("the original wording");
  });

  test("a verdict on a fact the job had no business checking is ignored", () => {
    seed([
      fact({ id: "f-1", text: "Ana tracks budget-vs-actuals", kind: "person" }),
      fact({ id: "f-2", text: "drained", retired: { at: "Fri", why: "moved" } }),
    ]);

    applyVerification(paths, "ozom-gv", {
      at,
      head: HEAD,
      checked: [
        { id: "f-1", holds: false, why: "I did not see her" },
        { id: "f-2", holds: true },
      ],
    });

    const after = readExpertDigest(paths, "ozom-gv")!;
    expect(after.facts[0]!.retired).toBeUndefined();
    expect(after.facts[1]!.retired!.why).toBe("moved");
    expect(after.facts[1]!.verifiedAt).toBeUndefined();
  });

  test("a drained fact with no stated reason still records one", () => {
    seed([fact({ id: "f-1", text: "a fact" })]);
    applyVerification(paths, "ozom-gv", { at, head: HEAD, checked: [{ id: "f-1", holds: false, why: "   " }] });
    expect(readExpertDigest(paths, "ozom-gv")!.facts[0]!.retired!.why).toBe("no longer true of this checkout");
  });

  test("a subject with no digest answers null rather than writing one", () => {
    expect(applyVerification(paths, "never-read", { at, head: HEAD, checked: [] })).toBeNull();
  });
});

/**
 * THE PROMPT'S ONE LOAD-BEARING INSTRUCTION. A model that treats "I could not
 * find it" as "it is false" will drain true facts every night, and a memory
 * that erodes under maintenance is worse than one nobody maintains.
 */
describe("the verification prompt", () => {
  test("it forbids treating absence of proof as disproof", () => {
    const prompt = verifyPrompt({ subject: "ozom-gv", facts: [{ id: "f-1", text: "a claim" }] });
    expect(prompt).toContain("not finding something is not evidence against it");
    expect(prompt).toContain("leave that fact out of your answer");
  });

  test("it renders every fact with its id, so a verdict can name one", () => {
    const prompt = verifyPrompt({ subject: "ozom-gv", facts: [{ id: "f-abc", text: "a claim" }] });
    expect(prompt).toContain("(f-abc) a claim");
  });

  test("it states that nothing it does changes the code", () => {
    const prompt = verifyPrompt({ subject: "ozom-gv", facts: [] });
    expect(prompt).toContain("nothing you write changes the code");
  });
});
