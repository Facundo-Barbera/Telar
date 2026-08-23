/**
 * The ephemeral per-project expert — ported from
 * `packages/core/test/workspace-expert.test.ts`.
 *
 * THE PASS IS DRIVEN WITH AN INJECTED `invoke`, so every branch runs without a
 * subprocess and without spending a cent. The one thing that genuinely needs a
 * second process is the COLD claim — see "rehydrates from disk alone" — because
 * proving "this prompt is a total function of (digest, item)" inside the process
 * that just wrote both proves nothing about ambient state.
 *
 * SANDBOX: an `fs.mkdtempSync` root per test handed in as `SpoolPaths`, matching
 * `spool-store.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StructuredAgentResult } from "../src/agent";
import {
  ExpertResult,
  expertPrompt,
  floatingExpertRefusal,
  runExpertPass,
  type ExpertDeps,
} from "../src/spool/expert";
import { createItem, ensureSpool, getSpoolItem, readExpertDigest, spoolPaths, writeExpertDigest, type SpoolPaths } from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-expert-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

const GOOD: ExpertResult = {
  fixed: "Add a retry to the nightly import so a 500 does not lose the run.",
  acceptance: ["retries three times", "logs each attempt"],
  note: "decompressed 'import flakes' into the retry it implies",
  commitments: [{ text: "I'll show Ana on Thursday", when: "Thursday" }],
  summary: "The import pipeline is the active surface this month.",
  methodology: "Trunk-based; every change lands behind a flag.",
  glossary: [{ term: "PD", means: "the portfolio dashboard" }],
  facts: [{ text: "the 500s come from the upstream vendor, not from us", kind: "howItWorks" as const }],
  retire: [],
};

/** An `invoke` that answers with whatever it is given, and records the prompt. */
function stub(result: StructuredAgentResult<ExpertResult>): ExpertDeps & { prompt?: string } {
  const deps: ExpertDeps & { prompt?: string } = {
    invoke: async (prompt) => {
      deps.prompt = prompt;
      return result;
    },
  };
  return deps;
}

const ok = (value: ExpertResult = GOOD): StructuredAgentResult<ExpertResult> => ({ ok: true, value });

function seed(input: { project?: string; title?: string; raw?: string } = {}) {
  return createItem(paths, {
    title: input.title ?? "import flakes",
    provenance: "typed",
    ...(input.project === undefined ? { project: "aurora" } : input.project ? { project: input.project } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  });
}

describe("what the expert is allowed to say", () => {
  test("the result shape has no field that could commit anything", () => {
    /**
     * PREPARE-NEVER-COMMIT IS ENFORCED BY THE SHAPE OF THE ANSWER, so the shape
     * is what this asserts. A field added later that names a status, a lane, a
     * start or an acceptance has to fail here first.
     *
     * `retire` WAS WEIGHED AGAINST THAT AND ADMITTED. It names no status and
     * starts nothing; it drains a fact the expert itself wrote, which is the
     * opposite direction from committing — and "no deletion path. Dismissing
     * drains" is the law it satisfies rather than bends, since a retired fact
     * stays on disk with its reason. `facts` replaced `notes` for the same
     * reason it is plural and addressable: memory that cannot be corrected is
     * memory that only accumulates error.
     */
    const keys = Object.keys(ExpertResult.shape).sort();
    expect(keys).toEqual([
      "acceptance",
      "commitments",
      "facts",
      "fixed",
      "glossary",
      "methodology",
      "note",
      "retire",
      "summary",
    ]);
  });

  test("no verdict, and no reasoning that would have explained one", () => {
    // Both went out with looms. The idiom suite guards the surfaces; this guards
    // the schema, which is the thing a future pass would be tempted to widen.
    expect(Object.keys(ExpertResult.shape)).not.toContain("verdict");
    expect(Object.keys(ExpertResult.shape)).not.toContain("reasoning");
  });
});

describe("the rehydration prompt", () => {
  test("the digest is read before the item — an expert reads who it is first", () => {
    const item = seed({ raw: "import flakes" });
    writeExpertDigest(paths, {
      project: "aurora",
      schemaVersion: 1,
      updated: "Mon",
      summary: "THE-SUMMARY",
      methodology: "",
      glossary: [],
      facts: [],
    });
    const prompt = expertPrompt({ project: "aurora", digest: readExpertDigest(paths, "aurora"), item });

    expect(prompt.indexOf("THE-SUMMARY")).toBeLessThan(prompt.indexOf("## The item"));
  });

  test("a first pass is told it has no memory, rather than being handed an empty one", () => {
    // An expert that believes it has context it does not have decompresses
    // shorthand by inventing meaning for it.
    const prompt = expertPrompt({ project: "aurora", digest: null, item: seed() });

    expect(prompt).toContain("There is no digest yet");
    expect(prompt).toContain("this is your first pass");
  });

  test("the capture is carried verbatim, under a heading that says so", () => {
    const item = seed({ raw: "pd import flakes on the 1st, ana asked" });
    const prompt = expertPrompt({ project: "aurora", digest: null, item });

    expect(prompt).toContain("### The capture, verbatim");
    expect(prompt).toContain("pd import flakes on the 1st, ana asked");
  });

  test("an item with no source gets no blank line where the source would be", () => {
    // A ternary falling back to "" produced deterministic prompt noise that
    // reads as a missing value.
    const item = seed({ raw: "a fragment" });
    const prompt = expertPrompt({ project: "aurora", digest: null, item });

    expect(prompt).toContain("### The capture, verbatim\na fragment");
  });

  test("it names no clock of its own", () => {
    // The module's law, and the prompt is the easiest place to break it: a date
    // computed here would become a date the expert reasons from.
    const item = seed({ raw: "x" });
    const prompt = expertPrompt({ project: "aurora", digest: null, item });

    expect(prompt).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(prompt).not.toMatch(/\bT\d\d:\d\d:\d\d/);
  });

  test("it forbids a calendar date across the WHOLE answer, not just the commitment field", () => {
    /**
     * REGRESSION, AND IT COST A REAL PASS TO FIND. `commitments.when` said
     * "never a date you computed" and the first live pass obeyed it — then
     * resolved "el jueves" into "2026-08-13" inside `fixed`, which is free prose
     * with no rule in front of it. The date landed in the packet and rendered on
     * the page.
     *
     * A per-field rule teaches a model to MOVE the date, not to drop it. This
     * asserts the instruction binds the answer, and says "every field" out loud
     * so a later edit cannot quietly narrow it back to one.
     */
    const prompt = expertPrompt({ project: "aurora", digest: null, item: seed() });

    expect(prompt).toContain("You do not know what today is");
    expect(prompt).toContain("Never turn the user's own time words into a calendar date");
    expect(prompt).toContain("in every field");
  });

  test("…and it forbids RESOLVING a date, not mentioning one a document already carried", () => {
    /**
     * THE SECOND HALF, AND THE SECOND LIVE PASS IS WHY IT EXISTS. The first fix
     * banned dates outright, which also banned "the reference doc (2026-08-12)
     * says the check was never run" — a date QUOTED from a file in the repo,
     * which no clock produced and which the user wants.
     *
     * Asserted so a later tightening cannot quietly take the useful half with
     * the harmful one.
     */
    const prompt = expertPrompt({ project: "aurora", digest: null, item: seed() });

    expect(prompt).toContain("You may quote a date that is written in a document you read");
    expect(prompt).toContain("attribute it");
    expect(prompt).toContain("never compute one");
  });

  test("it tells the expert plainly that nothing it returns starts work", () => {
    const prompt = expertPrompt({ project: "aurora", digest: null, item: seed() });

    expect(prompt).toContain("You may not change anything");
    expect(prompt).toContain("starts, completes or accepts work");
  });

  test("no loom, and no session-or-loom judgement to make", () => {
    const prompt = expertPrompt({ project: "aurora", digest: null, item: seed() });

    expect(prompt.toLowerCase()).not.toMatch(/\bloom\b/);
    expect(prompt.toLowerCase()).not.toMatch(/\bverdict\b/);
  });

  test("rehydrates from disk alone: a FRESH PROCESS builds a byte-identical prompt", () => {
    // CAP-9's actual claim, and it cannot be proved in-process. This spawns a
    // second bun that has only the digest and the packet on disk — no session,
    // no caller context, nothing this process is holding — and compares bytes.
    const item = seed({ raw: "pd import flakes" });
    writeExpertDigest(paths, {
      project: "aurora",
      schemaVersion: 1,
      updated: "Mon",
      summary: "The import pipeline is the active surface.",
      methodology: "Trunk-based.",
      glossary: [{ term: "PD", means: "the portfolio dashboard" }],
      facts: [{ id: "f-aaaaaaaaaaaa", text: "500s come from upstream", kind: "howItWorks" as const, source: { pass: "Mon" } }],
    });

    const here = expertPrompt({ project: "aurora", digest: readExpertDigest(paths, "aurora"), item });

    const dir = path.dirname(fileURLToPath(import.meta.url));
    const script = `
      const { expertPrompt } = await import(${JSON.stringify(path.join(dir, "../src/spool/expert.ts"))});
      const { readExpertDigest, getSpoolItem, spoolPaths } = await import(${JSON.stringify(path.join(dir, "../src/spool/store.ts"))});
      const paths = spoolPaths(${JSON.stringify(paths.root.replace(/\/spool$/, ""))});
      process.stdout.write(expertPrompt({
        project: "aurora",
        digest: readExpertDigest(paths, "aurora"),
        item: getSpoolItem(paths, ${JSON.stringify(item.id)}),
      }));
    `;
    const cold = spawnSync("bun", ["-e", script], { encoding: "utf8" });

    expect(cold.status).toBe(0);
    expect(cold.stdout).toBe(here);
  });
});

describe("what it refuses before spending anything", () => {
  test("an item that does not exist", async () => {
    const out = await runExpertPass(paths, { itemId: "nope", project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("No spool item found");
  });

  test("a floating item — having no project is a resting state, not an error", async () => {
    const item = createItem(paths, { title: "a loose thought", provenance: "typed" });
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(false);
    if (!out.ok) {
      // The one sentence, from the one place, naming the item.
      expect(out.reason).toBe(floatingExpertRefusal("a loose thought"));
      expect(out.reason).toContain("a loose thought");
    }
  });

  test("an item belonging to a different project — the cross-project leak", async () => {
    const item = seed({ project: "borealis" });
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("belongs to borealis, not aurora");
  });

  test("a project name the store cannot address, checked BEFORE the model call", async () => {
    // Without this the mismatch surfaced after the model call and after the
    // packet write: money spent, half the pass on disk.
    const item = seed({ project: "My Project/../etc" });
    const deps = stub(ok());
    const out = await runExpertPass(paths, { itemId: item.id, project: "My Project/../etc" }, deps);

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no expert was called");
    // The proof that it was cheap: the model was never reached.
    expect(deps.prompt).toBeUndefined();
  });
});

describe("the pass itself", () => {
  test("a good pass enriches the packet and writes the digest", async () => {
    const item = seed({ raw: "import flakes" });
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.applied.item.fixed).toBe(GOOD.fixed);
    expect(out.applied.item.acceptance).toEqual(GOOD.acceptance);
    expect(out.digest.summary).toBe(GOOD.summary);
    expect(readExpertDigest(paths, "aurora")?.methodology).toBe(GOOD.methodology);
  });

  test("the raw capture is never overwritten — it is what lets the user check for drift", async () => {
    const item = seed({ raw: "import flakes" });
    await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(getSpoolItem(paths, item.id)?.raw).toBe("import flakes");
  });

  test("everything the pass appends to the timeline is marked a proposal", async () => {
    const item = seed({ raw: "import flakes" });
    const before = (item.timeline ?? []).length;
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ONLY WHAT THE PASS ADDED. The item's own birth event is deliberately not a
    // proposal — the capture genuinely happened — so sweeping the whole timeline
    // in would assert the opposite of the law on the one event that is exempt.
    const added = (out.applied.item.timeline ?? []).slice(before);
    expect(added.length).toBe(out.applied.events);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((e) => e.proposal === true)).toBe(true);
  });

  test("the item's own birth event is NOT a proposal — a capture is a fact", async () => {
    // The other half of the rule above, asserted so the exemption stays
    // deliberate rather than becoming a gap someone closes by accident.
    const item = seed({ raw: "import flakes" });

    expect(item.timeline?.[0]?.actor).toBe("session");
    expect(item.timeline?.[0]?.proposal).toBeUndefined();
  });

  test("the digest and the pass's timeline events carry the SAME label", async () => {
    // Minted once by the store's clock and reported back, rather than each side
    // re-deriving one.
    const item = seed();
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.digest.updated).toBe(out.applied.at);
    expect(out.applied.item.timeline?.[0]?.at).toBe(out.applied.at);
  });

  test("`cold` is true on the first pass and false on the second", async () => {
    // Reported so a surface can say "first pass" honestly rather than implying
    // memory the expert did not have.
    const item = seed();
    const first = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));
    const second = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(first.ok && first.cold).toBe(true);
    expect(second.ok && second.cold).toBe(false);
  });

  test("a pass with no checkout reports that it had none", async () => {
    // `cold` is about the digest, not the tree — without this a caller narrating
    // a consultation cannot say the expert judged the item without ever seeing
    // the project.
    const item = seed();
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok && out.cwd).toBeUndefined();
  });

  test("usage rides back, so a night of passes can be totalled", async () => {
    const item = seed();
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, {
      invoke: async () => ({
        ok: true,
        value: GOOD,
        usage: { tokens: { input: 10, output: 2, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.004 },
      }),
    });

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.usage?.costUsd).toBe(0.004);
  });
});

describe("when the call fails, nothing is written", () => {
  test("a model that never emitted leaves the packet untouched", async () => {
    const item = seed({ raw: "import flakes" });
    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, {
      invoke: async () => ({ ok: false, kind: "no-result", reason: "expert:aurora: the model finished without emitting a result; nothing was written." }),
    });

    expect(out.ok).toBe(false);
    // UNTOUCHED MEANS UNCHANGED FROM BEFORE THE PASS, not empty: the item was
    // born with its own capture event and that is not the pass's doing.
    const after = getSpoolItem(paths, item.id);
    expect(after?.fixed).toBeUndefined();
    expect(after?.timeline).toEqual(item.timeline);
    // And no digest, so the next pass starts cold from the same disk state
    // rather than warm from a pass that never landed.
    expect(readExpertDigest(paths, "aurora")).toBeNull();
  });

  test("the runner's own sentence is passed through, not replaced with a generic one", async () => {
    // "never answered", "answered in the wrong shape" and "there is no Claude
    // here" are three different things for a user to do next.
    const item = seed();
    for (const reason of ["it never answered", "the shape did not fit", "install Claude Code"]) {
      const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, {
        invoke: async () => ({ ok: false, kind: "no-result", reason }),
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe(reason);
    }
  });

  test("a digest write that fails AFTER the packet landed says so, and warns off the retry", async () => {
    // The one step that can fail after a write has already committed. Its
    // sentence has to be accurate about what is on disk, because the obvious
    // recovery — run it again — appends the mined commitments a second time.
    const item = seed({ raw: "import flakes" });
    const digestDir = path.join(paths.root, "experts");
    fs.mkdirSync(path.dirname(digestDir), { recursive: true });
    // A FILE where the experts DIRECTORY must go: the packet write succeeds and
    // the digest write cannot.
    fs.writeFileSync(digestDir, "not a directory");

    const out = await runExpertPass(paths, { itemId: item.id, project: "aurora" }, stub(ok()));

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("DID land");
      expect(out.reason).toContain("Do not repeat the pass");
    }
    // And the claim in that sentence is true: the enrichment really is on disk.
    expect(getSpoolItem(paths, item.id)?.fixed).toBe(GOOD.fixed);
  });
});
