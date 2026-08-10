// The ephemeral per-project expert's proof (story 5.8, CAP-9).
//
// SANDBOX MECHANISM: the same first-of-three sanctioned one workspace-store.test.ts
// uses — TELAR_HOME pinned to an fs.mkdtempSync root at module scope AND re-pinned
// in a beforeEach, because bun runs every suite in ONE process and a sibling file
// can move the variable out from under this one. TELAR_HOME is never blanked to
// "disable" a read: an empty TELAR_HOME resolves to the operator's real ~/.telar.
//
// THE MODEL IS NEVER CALLED. Every pass here goes through runExpertPass's `deps.invoke`
// seam with a stub, which is what lets this suite assert the DETERMINISTIC half —
// what is written, in what order, and what is refused — without a network, a key or
// a nondeterministic answer. The one thing a stub cannot prove is "a cold process
// really has only the digest", so that claim is proved by SPAWNING ONE (below).
// This workspace has no @types/bun, so the import below is one TS2307 — the
// per-file cost scripts/typecheck-ceiling.mjs counts 116 of. The directive is
// the workaround apps/web already uses and the one that file names, so a NEW
// test does not raise a ceiling that "may never be raised".
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "telar-workspace-expert-"));
const ORIGINAL_HOME = process.env.TELAR_HOME;
process.env.TELAR_HOME = HOME;

beforeEach(() => {
  process.env.TELAR_HOME = HOME;
  fs.rmSync(path.join(HOME, "workspace"), { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.TELAR_HOME;
  else process.env.TELAR_HOME = ORIGINAL_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const {
  applyExpertPass,
  createItem,
  expertDigestPath,
  getWorkspaceItem,
  listExpertDigests,
  listItems,
  minedCommitments,
  readExpertDigest,
  setItemVerdict,
  updateItem,
  writeExpertDigest,
} = await import("../src/workspace/store");
const {
  ExpertResult: ExpertResultSchema,
  expertAgentOptions,
  expertPrompt,
  floatingExpertRefusal,
  runExpertPass,
} = await import("../src/workspace/expert");
const { DIGEST_SCHEMA_VERSION, ExpertDigest } = await import("../src/workspace/schema");
type ExpertResult = import("../src/workspace/expert").ExpertResult;
type Item = import("../src/workspace/schema").Item;

// Paths composed here on purpose: this suite asserts the LAYOUT, so re-deriving
// it from the module under test would assert nothing.
const digestFile = (project: string) =>
  path.join(HOME, "workspace", "experts", project, "digest.yaml");
const packetPath = (id: string) => path.join(HOME, "workspace", "packets", id, "packet.yaml");
const hashOf = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// A complete expert answer. Every field the forced schema requires, so a test
// that cares about one of them still exercises the real write path for the rest.
const RESULT: ExpertResult = {
  fixed: "Rewrite the ingest adapter so a partial batch is retried per record.",
  acceptance: ["a half-failed batch retries only the failed records", "no record is applied twice"],
  verdict: "loom",
  reasoning: "the objective is stable and checkable, so it can be planned and verified",
  note: "decompressed “fix the SEP path” into the adapter change it means here",
  commitments: [{ text: "I'll show Dana the retry numbers", when: "Thursday" }],
  summary: "Atlas is mid-migration; the ingest adapter is the last piece.",
  methodology: "Atlas plans in weekly batches and reviews on Thursdays.",
  glossary: [{ term: "the SEP path", means: "the streaming-ingest adapter in src/sep" }],
  notes: ["Dana owns the review slot"],
};

const stub = (result: ExpertResult | null = RESULT) => {
  const seen: string[] = [];
  return {
    seen,
    deps: {
      invoke: async (prompt: string) => {
        seen.push(prompt);
        return result;
      },
    },
  };
};

const seedItem = (over: Partial<Parameters<typeof createItem>[0]> = {}): Item =>
  createItem({
    title: "fix the SEP path",
    project: "atlas",
    raw: "fix the SEP path before the demo, told Dana I'd show her the retry numbers Thursday",
    rawSource: "note",
    ...over,
  });

// ── the digest on disk ───────────────────────────────────────────────────────

describe("the expert digest", () => {
  test("lives at workspace/experts/<project>/digest.yaml and round-trips", () => {
    const written = writeExpertDigest(
      ExpertDigest.parse({ project: "atlas", updated: "Tue 16:42", summary: "mid-migration" }),
    );
    // THE LAYOUT IS THE CLAIM: a sibling of lanes.yaml and packets/, under the
    // one owned root, project-keyed rather than item-keyed.
    expect(fs.existsSync(digestFile("atlas"))).toBe(true);
    expect(expertDigestPath("atlas")).toBe(digestFile("atlas"));
    expect(written.schemaVersion).toBe(DIGEST_SCHEMA_VERSION);
    const back = readExpertDigest("atlas");
    expect(back?.summary).toBe("mid-migration");
    expect(back?.project).toBe("atlas");
    // YAML on disk, hand-readable like every other file in this store (AD-6).
    expect(YAML.parse(fs.readFileSync(digestFile("atlas"), "utf8")).project).toBe("atlas");
  });

  test("a missing digest reads as null — a cold expert, not an error", () => {
    expect(readExpertDigest("atlas")).toBe(null);
    expect(listExpertDigests()).toEqual([]);
  });

  test("an unreadable or version-ahead digest degrades to null rather than throwing", () => {
    fs.mkdirSync(path.dirname(digestFile("atlas")), { recursive: true });
    fs.writeFileSync(digestFile("atlas"), "{{{ not yaml");
    expect(readExpertDigest("atlas")).toBe(null);
    // Unlike a packet, a digest is re-derivable: the next pass rewrites it, so
    // "cannot read" costs one cold pass and loses nothing a human authored.
    fs.writeFileSync(digestFile("atlas"), YAML.stringify({ project: "atlas" })); // no `updated`
    expect(readExpertDigest("atlas")).toBe(null);
  });

  test("a project name that cannot be addressed is refused on write and null on read", () => {
    // The traversal case is not hypothetical — a project name is a registry key
    // a human types.
    expect(() => writeExpertDigest(ExpertDigest.parse({ project: "../escape", updated: "x" }))).toThrow(
      /invalid project/,
    );
    expect(readExpertDigest("../escape")).toBe(null);
    expect(fs.existsSync(path.join(HOME, "workspace", "escape"))).toBe(false);
  });

  test("listExpertDigests reports every project with a readable digest, sorted, skipping the rest", () => {
    writeExpertDigest(ExpertDigest.parse({ project: "atlas", updated: "a" }));
    writeExpertDigest(ExpertDigest.parse({ project: "beam", updated: "b" }));
    fs.mkdirSync(path.join(HOME, "workspace", "experts", "junk"), { recursive: true });
    expect(listExpertDigests().map((d) => d.project)).toEqual(["atlas", "beam"]);
  });

  test("digests are NOT in workspaceStorePaths — the master must be able to read them", async () => {
    const { workspaceStorePaths } = await import("../src/workspace/store");
    // protectedPaths denies READS as well as writes, and "experts write, master
    // reads" requires the read. Asserted so a later tidy-up cannot quietly
    // protect the digests and silently blind the master.
    expect(workspaceStorePaths().some((p) => p.includes("experts"))).toBe(false);
  });
});

// ── the enrichment pass's write ──────────────────────────────────────────────

describe("the enrichment pass", () => {
  test("writes the brief, the verdict, the reasoning and the mined commitments", async () => {
    const item = seedItem();
    const s = stub();
    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, s.deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const after = getWorkspaceItem(item.id)!;
    expect(after.fixed).toBe(RESULT.fixed);
    expect(after.acceptance).toEqual(RESULT.acceptance);
    expect(after.verdict).toBe("loom");
    expect(out.verdictHeld).toBe(false);
    // THE REASONING IS A TIMELINE EVENT, NOT A HIDDEN FIELD (item-model.md):
    // the user reads WHY before deciding whether to override.
    const texts = (after.timeline ?? []).map((e) => e.text);
    expect(texts.some((t) => t.includes(RESULT.reasoning))).toBe(true);
    expect(texts).toContain(RESULT.note);
    // Every expert event is attributed and flagged as awaiting a human look.
    const expertEvents = (after.timeline ?? []).filter((e) => e.actor === "expert");
    expect(expertEvents.length).toBe(3);
    expect(expertEvents.every((e) => e.proposal === true)).toBe(true);
    // The mined commitment keeps the capture's own words, carries its item, and
    // its `when` is the coarse label the expert heard — never a computed date.
    expect(after.commitments?.length).toBe(1);
    expect(after.commitments?.[0]?.text).toBe("I'll show Dana the retry numbers");
    expect(after.commitments?.[0]?.when).toBe("Thursday");
    expect(after.commitments?.[0]?.itemId).toBe(item.id);
    expect(after.commitments?.[0]?.id).toMatch(/^x-[0-9a-f]{12}$/);
  });

  test("never overwrites raw or rawSource, and never writes a status", async () => {
    const item = seedItem();
    const s = stub();
    await runExpertPass({ itemId: item.id, project: "atlas" }, s.deps);
    const after = getWorkspaceItem(item.id)!;
    // AC9/NFR-OW-19: `fixed` lands BESIDE the original so the user can check the
    // expert did not drift from what they meant.
    expect(after.raw).toBe(
      "fix the SEP path before the demo, told Dana I'd show her the retry numbers Thursday",
    );
    expect(after.rawSource).toBe("note");
    // The Human-Accept Moat, read off the bytes: no status/accepted/done anywhere.
    const yaml = fs.readFileSync(packetPath(item.id), "utf8");
    expect(/^\s*(status|accepted|done|completed):/m.test(yaml)).toBe(false);
  });

  test("is packet-only — lanes.yaml is byte-identical across a pass", async () => {
    const item = seedItem({ lane: undefined });
    const lanes = path.join(HOME, "workspace", "lanes.yaml");
    const before = hashOf(lanes);
    await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    // Enrichment is not routing. A pass that could re-file items would be an
    // agent changing queue structure as a side effect.
    expect(hashOf(lanes)).toBe(before);
  });

  test("commitments append across passes rather than replacing", async () => {
    const item = seedItem();
    await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    await runExpertPass(
      { itemId: item.id, project: "atlas" },
      stub({ ...RESULT, commitments: [{ text: "I'll send the draft", when: "Friday" }] }).deps,
    );
    const after = getWorkspaceItem(item.id)!;
    expect(after.commitments?.map((c) => c.when)).toEqual(["Thursday", "Friday"]);
  });

  test("a pass that returns nothing writes nothing at all", async () => {
    const item = seedItem();
    writeExpertDigest(ExpertDigest.parse({ project: "atlas", updated: "Tue 16:42", summary: "before" }));
    const packetBefore = hashOf(packetPath(item.id));
    const digestBefore = hashOf(digestFile("atlas"));

    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, stub(null).deps);
    expect(out.ok).toBe(false);
    // A half-pass — a brief with no verdict, or a digest with no pass behind it —
    // is worse than no pass: the next one starts cold from the same disk state.
    expect(hashOf(packetPath(item.id))).toBe(packetBefore);
    expect(hashOf(digestFile("atlas"))).toBe(digestBefore);
    expect(readExpertDigest("atlas")?.summary).toBe("before");
  });

  test("refuses a floating item, and refuses to answer for another project", async () => {
    const floating = createItem({ title: "call the dentist" });
    const floatOut = await runExpertPass({ itemId: floating.id, project: "atlas" }, stub().deps);
    expect(floatOut.ok).toBe(false);
    // Floating is a resting state, so the refusal names what the human can do —
    // AND IT IS THE EXPORTED SENTENCE, not a copy of its words. apps/web's
    // consultExpert refuses the same case one layer up; both read this function,
    // so rewording it cannot leave the two layers disagreeing (the seam a
    // `toMatch(/floating/)` on each side would have hidden).
    if (!floatOut.ok) expect(floatOut.reason).toBe(floatingExpertRefusal("call the dentist"));
    if (!floatOut.ok) expect(floatOut.reason).toMatch(/floating/);

    const atlas = seedItem();
    const wrong = await runExpertPass({ itemId: atlas.id, project: "beam" }, stub().deps);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toMatch(/belongs to atlas/);
    // Neither refusal wrote anything.
    expect(getWorkspaceItem(atlas.id)?.fixed).toBeUndefined();
    expect(readExpertDigest("beam")).toBe(null);
  });

  // ── the two ways a pass can fail AFTER something is on disk, and the one way
  //    it must not (fix-round) ─────────────────────────────────────────────────

  test("a project name the store cannot address is refused BEFORE the model call, not after the packet write", async () => {
    // REACHABLE, not hypothetical: `Item.project` is a bare optional string with
    // no slug guard, and PATCH /api/workspace/items/<id> has `project` in its
    // patchable keys — so any name with a space or a slash gets this far. The
    // digest's directory (`experts/<project>/`) refuses it. Before the fix that
    // collision surfaced at the LAST step: the model was paid, the enrichment was
    // committed, and the throw escaped as "nothing was written".
    const item = seedItem({ project: "My Project" });
    const packetBefore = hashOf(packetPath(item.id));
    const s = stub();
    const out = await runExpertPass({ itemId: item.id, project: "My Project" }, s.deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("My Project");
      // The name of the repair, and the honest claim about disk.
      expect(out.reason).toContain("plain slug");
      expect(out.reason).toContain("nothing was written");
    }
    // NO MODEL CALL AT ALL — the refusal is ahead of the money, which is the whole
    // difference between this and catching the throw at the end.
    expect(s.seen.length).toBe(0);
    // And the packet is byte-identical: no brief, no verdict, no mined commitment.
    expect(hashOf(packetPath(item.id))).toBe(packetBefore);
    expect(getWorkspaceItem(item.id)?.fixed).toBeUndefined();
  });

  test("a digest write that fails says the enrichment LANDED — and warns off the retry that would double it", async () => {
    const item = seedItem();
    // Force the one failure the pre-flight above cannot rule out: a real
    // filesystem refusal at the digest's own path. `experts/atlas` is occupied by
    // a FILE, so atomicWrite's mkdirSync throws — the same shape as ENOSPC or a
    // permission fault, and the only way to reach this branch deterministically.
    fs.mkdirSync(path.join(HOME, "workspace", "experts"), { recursive: true });
    fs.writeFileSync(path.join(HOME, "workspace", "experts", "atlas"), "not a directory");

    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // THE SENTENCE IS THE PRODUCT HERE. The tool surface reads it back to the
      // user, and the old behaviour — a throw the caller translated into "Nothing
      // was written." — was a categorical falsehood that invited exactly the
      // retry the last clause forbids.
      expect(out.reason).toContain("DID land");
      expect(out.reason).toContain("Do not repeat the pass");
      expect(out.reason).not.toContain("nothing was written");
    }
    // The packet-first ordering is what makes that sentence true: the human's own
    // item carries the whole enrichment, and only the expert's memory is lost.
    const after = getWorkspaceItem(item.id)!;
    expect(after.fixed).toBe(RESULT.fixed);
    expect(after.verdict).toBe("loom");
    expect(after.commitments?.length).toBe(1);
    expect(readExpertDigest("atlas")).toBe(null);
  });

  test("the digest's `updated` label is the pass's own, taken from the store rather than read back off the timeline", async () => {
    const item = seedItem();
    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ONE LABEL FOR ONE PASS. applyExpertPass mints it (its clock, the store's
    // own `capturedLabel`) and reports it, so the digest and the timeline events
    // of a single pass cannot disagree — and there is no fallback branch claiming
    // the CAPTURE's clock, which is what the `?? item.captured` arm did while
    // being unreachable.
    expect(out.digest.updated).toBe(out.applied.at);
    expect((out.applied.item.timeline ?? []).at(-1)?.at).toBe(out.applied.at);
  });

  test("an unknown item gets the store's own anti-oracle wording", async () => {
    const out = await runExpertPass({ itemId: "i-nope", project: "atlas" }, stub().deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('No workspace item found with id "i-nope".');
  });

  test("the outcome says whether the expert had the project's files, which is not what `cold` says", async () => {
    const item = seedItem();
    const withTree = await runExpertPass({ itemId: item.id, project: "atlas", cwd: "/tmp/atlas" }, stub().deps);
    expect(withTree.ok && withTree.cwd).toBe("/tmp/atlas");
    // NO CHECKOUT IS A SUPPORTED STATE (a mirrored project with no local clone is
    // the case CAP-9 is for) — but it is a DIFFERENT fact from `cold`, which is
    // about the digest. Echoed so a surface narrating the pass can say the expert
    // judged the item without ever seeing the tree, instead of leaving a master to
    // imply it read the repo.
    const noTree = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(noTree.ok).toBe(true);
    if (noTree.ok) expect("cwd" in noTree).toBe(false);
  });

  test("writes the digest the next cold pass rehydrates from", async () => {
    const item = seedItem();
    const first = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(first.ok && first.cold).toBe(true);
    const digest = readExpertDigest("atlas")!;
    expect(digest.summary).toBe(RESULT.summary);
    expect(digest.methodology).toBe(RESULT.methodology);
    expect(digest.glossary[0]?.term).toBe("the SEP path");
    expect(digest.notes).toEqual(["Dana owns the review slot"]);

    const second = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    // The second pass is not cold, and it knows it — a surface can say "first
    // pass" honestly rather than implying memory it did not have.
    expect(second.ok && second.cold).toBe(false);
  });
});

// ── the human override is durable ────────────────────────────────────────────

describe("the verdict override", () => {
  test("a human verdict survives a later expert pass, and the disagreement is recorded", async () => {
    const item = seedItem();
    await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(getWorkspaceItem(item.id)?.verdict).toBe("loom");

    setItemVerdict(item.id, "session");
    const overridden = getWorkspaceItem(item.id)!;
    expect(overridden.verdict).toBe("session");
    expect(overridden.verdictOverride).toBe(true);
    // The human's own event: actor "you", and NOT a proposal — nobody needs to
    // review a click.
    const mine = (overridden.timeline ?? []).at(-1)!;
    expect(mine.actor).toBe("you");
    expect(mine.proposal).toBeUndefined();

    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const after = getWorkspaceItem(item.id)!;
    // CAP-9: "a human override is durable, and a later expert pass does not
    // re-flip it".
    expect(after.verdict).toBe("session");
    expect(after.verdictOverride).toBe(true);
    // Held is REPORTED, so the tool surface cannot tell the user their verdict
    // changed when it did not…
    expect(out.verdictHeld).toBe(true);
    expect(out.verdict).toBe("loom");
    // …and the expert's disagreeing reading is still on the timeline. Dropping
    // it would leave the user unable to see that a fresh look disagreed.
    const texts = (after.timeline ?? []).map((e) => e.text);
    expect(texts.some((t) => t.includes("reads this as loom") && t.includes("stands"))).toBe(true);
    // The rest of the enrichment still landed.
    expect(after.fixed).toBe(RESULT.fixed);
  });

  test("the prompt tells the expert the human already decided", async () => {
    const item = seedItem();
    setItemVerdict(item.id, "session");
    const s = stub();
    await runExpertPass({ itemId: item.id, project: "atlas" }, s.deps);
    expect(s.seen[0]).toContain('The user set this item\'s verdict to "session"');
  });

  test("updateItem refuses to re-flip an override, and allows agreeing with it", () => {
    const item = seedItem();
    setItemVerdict(item.id, "session");
    // `update_item` is an AGENT tool and `verdict` is patchable, so without this
    // gate the generic verb would be the way round the override. It THROWS
    // rather than dropping the key: silently ignoring a patch is
    // indistinguishable from honouring it.
    expect(() => updateItem(item.id, { verdict: "loom" })).toThrow(/CAP-9/);
    expect(getWorkspaceItem(item.id)?.verdict).toBe("session");
    // Agreeing is not a change, so it passes.
    expect(updateItem(item.id, { verdict: "session" })?.verdict).toBe("session");
    // And an item with no override is patchable as before.
    const other = seedItem();
    expect(updateItem(other.id, { verdict: "loom" })?.verdict).toBe("loom");
  });

  test("nothing but setItemVerdict can raise the durable flag", () => {
    const item = seedItem();
    // Not patchable — the type forbids it and the runtime check is the second
    // half of the same rule.
    expect(() => updateItem(item.id, { verdictOverride: true } as never)).toThrow(/verdictOverride/);
    // And an expert pass cannot mint one: it writes a verdict, never an override.
    applyExpertPass(item.id, { verdict: "loom", reasoning: "why" });
    expect(getWorkspaceItem(item.id)?.verdictOverride).toBeUndefined();
  });
});

// ── the flat commitment projection (story 5.10's input) ──────────────────────

describe("minedCommitments", () => {
  test("gathers every commitment in the store, each carrying its own item", async () => {
    const a = seedItem({ title: "fix the SEP path" });
    const b = seedItem({ title: "draft the ingest note" });
    await runExpertPass({ itemId: a.id, project: "atlas" }, stub().deps);
    await runExpertPass(
      { itemId: b.id, project: "atlas" },
      stub({ ...RESULT, commitments: [{ text: "I'll send the draft", when: "Friday" }] }).deps,
    );
    const all = minedCommitments(listItems().items);
    expect(all.length).toBe(2);
    expect(new Set(all.map((c) => c.itemId))).toEqual(new Set([a.id, b.id]));
    // A pure projection: no disk, and NO CLOCK — nothing here decides whether
    // "Thursday" has passed. NFR-OW-11; story 5.10 asks the human.
    expect(all.every((c) => typeof c.when === "string")).toBe(true);
  });
});

// ── ephemeral by construction ────────────────────────────────────────────────

describe("no expert process persists between calls", () => {
  test("a COLD PROCESS composes a byte-identical prompt from the digest alone", async () => {
    const item = seedItem();
    await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);

    const warm = expertPrompt({
      project: "atlas",
      digest: readExpertDigest("atlas"),
      item: getWorkspaceItem(item.id)!,
    });

    // THE CLAIM CAP-9 MAKES IS ABOUT A PROCESS, so it is proved with one. This
    // child shares nothing with this suite but TELAR_HOME: no module instance,
    // no cache, no handle, no in-memory digest. If rehydration depended on
    // anything held in memory between calls, these two strings would differ.
    const EXPERT_MODULE = fileURLToPath(new URL("../src/workspace/expert.ts", import.meta.url));
    const STORE_MODULE = fileURLToPath(new URL("../src/workspace/store.ts", import.meta.url));
    const script = `
      const { expertPrompt } = await import(${JSON.stringify(EXPERT_MODULE)});
      const { readExpertDigest, getWorkspaceItem } = await import(${JSON.stringify(STORE_MODULE)});
      process.stdout.write(
        expertPrompt({
          project: "atlas",
          digest: readExpertDigest("atlas"),
          item: getWorkspaceItem(${JSON.stringify(item.id)}),
        }),
      );
    `;
    const child = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TELAR_HOME: HOME },
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(warm);
    // And the prompt really is carrying the project's memory, not boilerplate.
    expect(child.stdout).toContain("the streaming-ingest adapter in src/sep");
    expect(child.stdout).toContain("You are the atlas expert.");
  });

  test("with no digest the prompt says so instead of implying memory", () => {
    const item = seedItem();
    const cold = expertPrompt({ project: "atlas", digest: null, item: getWorkspaceItem(item.id)! });
    // An expert that believes it has context it does not have will decompress
    // shorthand by inventing meaning for it.
    expect(cold).toContain("There is no digest yet");
    expect(cold).toContain("fix the SEP path before the demo");
  });

  test("a capture with no source is not preceded by an empty line where the source would be", () => {
    // The source line used to be pushed as a ternary falling back to "", so every
    // item without a `rawSource` got a blank line between the heading and its own
    // words — deterministic prompt noise that reads as a missing value.
    const withSource = seedItem();
    const without = seedItem({ rawSource: undefined, raw: "call the bank" });
    const a = expertPrompt({ project: "atlas", digest: null, item: getWorkspaceItem(withSource.id)! });
    const b = expertPrompt({ project: "atlas", digest: null, item: getWorkspaceItem(without.id)! });
    expect(a).toContain("### The capture, verbatim\n(from note)\nfix the SEP path");
    expect(b).toContain("### The capture, verbatim\ncall the bank");
    expect(b).not.toContain("### The capture, verbatim\n\n");
  });

  test("the module holds no state between passes", async () => {
    const item = seedItem();
    await runExpertPass({ itemId: item.id, project: "atlas" }, stub().deps);
    // Delete the digest between calls and the next pass is cold again — which it
    // could not be if anything were cached in this process.
    fs.rmSync(digestFile("atlas"));
    const s = stub();
    const out = await runExpertPass({ itemId: item.id, project: "atlas" }, s.deps);
    expect(out.ok && out.cold).toBe(true);
    expect(s.seen[0]).toContain("There is no digest yet");
  });
});

// ── the capability wall, read as a value ─────────────────────────────────────

// WHY THESE ARE ASSERTED AT ALL. Every other claim in this file is about disk;
// these are about the ONE call this module makes to a model, and that call is the
// only place an expert could stop being read-only, stop being ephemeral, or
// quietly inherit a repo's `.claude` config. None of it is observable without a
// provider unless the options are a value — which is why `expertAgentOptions` is
// exported and pure. The stub-driven passes above never reach it, so without this
// block the wall would be entirely untested.
describe("expertAgentOptions — what the one model call is allowed to be", () => {
  test("read-only twice over: availability restricted, and the write verbs named", () => {
    const o = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    expect(o.tools).toEqual(["Read", "Grep", "Glob"]);
    // Not just "not granted". Under bypassPermissions an allow-list does not
    // gate availability, so this flag is the actual wall (engine.ts).
    expect(o.restrictTools).toBe(true);
    // And the belt to that braces — an explicit SDK disallow outranks any allow,
    // including one a repo's own settings could introduce.
    expect(o.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"]);
    for (const verb of ["Write", "Edit", "Bash"]) expect(o.tools).not.toContain(verb);
  });

  test("no expert can spawn an expert — 'Agent' is denied, which is what keeps the pass a leaf", () => {
    const o = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    // SPEC.md's inverted scope: a harness sub-agent inherits the CALLER's cwd
    // and policy, so one spawned here would be an atlas-shaped agent claiming to
    // be some other project's expert — and "no expert process persists between
    // calls" would only ever have been a claim about the outermost one.
    expect(o.disallowedTools).toContain("Agent");
  });

  test("nothing is inherited: the model is named, the turn ceiling is stated, and no ambient config is read", () => {
    const o = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    expect(o.model).toBe("sonnet");
    // A pass that runs out of turns returns no structured result, and
    // runExpertPass then writes NOTHING (proved above) — so the cap is generous
    // by design and the number is written down rather than defaulted.
    expect(o.maxTurns).toBe(40);
    expect(o.settingSources).toEqual([]);
    // An enrichment pass is background work; it must never take an admission
    // slot ahead of something a human is waiting on.
    expect(o.admissionClass).toBe("other");
    // And the result is forced into the shape that cannot commit anything.
    expect(o.schema).toBe(ExpertResultSchema);
  });

  test("the request's own scope rides through, and absent parts stay absent", () => {
    const abort = new AbortController();
    const full = expertAgentOptions({
      itemId: "i-1",
      project: "atlas",
      cwd: "/tmp/atlas",
      abort,
    });
    expect(full.cwd).toBe("/tmp/atlas");
    expect(full.abort).toBe(abort);
    expect(full.label).toBe("expert:atlas");
    // THE MODEL IS NOT PART OF "OWN SCOPE". `ExpertPassRequest` carried a `model`
    // key until the fix round and nothing but this test could spell it — no tool
    // input, no route, no option on consultExpert. A per-call override only a test
    // can reach is the parameter a later story threads out of TOOL input, at which
    // point a model the operator never chose runs on the user's own checkout. It
    // is off the request shape now (the compiler enforces that), and the second
    // assertion is the runtime half: a stray key changes nothing.
    expect(full.model).toBe("sonnet");
    expect(expertAgentOptions({ itemId: "i-1", project: "atlas", ...({ model: "opus" } as object) }).model).toBe(
      "sonnet",
    );

    // THE PROJECT WITH NO CHECKOUT. CAP-9's claim is that the digest alone is
    // enough, so a missing cwd is a supported state, not a hole to fill with the
    // process's own directory — which would be the master's, i.e. no project's.
    const bare = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    expect(bare.cwd).toBeUndefined();
    expect(bare.abort).toBeUndefined();
    expect(bare.account).toBeUndefined();
    expect("cwd" in bare).toBe(false);
  });

  test("it is pure — same request, same wall, and no shared array to mutate", () => {
    const a = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    const b = expertAgentOptions({ itemId: "i-1", project: "atlas" });
    expect(a).toEqual(b);
    // Copies, not the module's own constants: a caller that pushed onto
    // `o.tools` would otherwise widen every later expert's capability wall.
    expect(a.tools).not.toBe(b.tools);
    expect(a.disallowedTools).not.toBe(b.disallowedTools);
    a.tools!.push("Bash");
    expect(expertAgentOptions({ itemId: "i-1", project: "atlas" }).tools).toEqual(["Read", "Grep", "Glob"]);
  });
});
