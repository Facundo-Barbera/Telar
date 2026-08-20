/**
 * The night — what it plans, what stops it, and what survives being stopped.
 *
 * EVERY STOP SIGNAL IS DRIVEN HERE WITHOUT A MODEL, which is the whole reason
 * the runner takes its two expensive calls as injected dependencies. A system
 * that spends money unattended at 3am has to have its stopping conditions
 * provable at noon for free — otherwise the only way to find out what it does
 * when the account runs dry is to let the account run dry.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpoolNightJob, type SpoolItem } from "@telar/engine-client";
import {
  needsDrafting,
  needsRipening,
  nightDeps,
  planNight,
  readNight,
  runNight,
  draftPrompt,
  type NightDeps,
} from "../src/spool/night";
import {
  createItem,
  ensureSpool,
  getSpoolItem,
  spoolPaths,
  writeExpertDigest,
  type SpoolPaths,
} from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-night-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
  provenance: "session",
  captured: "Fri 22:00",
  schemaVersion: 1,
  ...over,
});

/** A shorthand fragment with a subject: the thing a night exists to ripen. */
function seedRaw(title: string, project = "aurora") {
  return createItem(paths, { title, provenance: "typed", project, raw: `${title} — shorthand` });
}

const GOOD_DRAFT = {
  approach: "Read the importer, then add the retry at its boundary.",
  risks: ["the vendor may rate limit us too"],
  openQuestions: ["is three attempts enough?"],
  note: "drafted an approach for the retry",
};

/** A successful expert pass, as the runner sees one. Named because eight tests
 *  needed it and eight copies of a nine-key literal is where a fixture drifts. */
const okPass = () => ({
  ok: true as const,
  project: "aurora",
  applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri 22:05" },
  digest: { project: "aurora", schemaVersion: 1, updated: "Fri 22:05", summary: "", methodology: "", glossary: [], notes: [] },
  cold: false,
});

function deps(over: Partial<NightDeps> = {}): NightDeps {
  return {
    ripen: over.ripen ?? (async () => ({ ok: true, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri 22:05" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri 22:05", summary: "", methodology: "", glossary: [], notes: [] }, cold: false })),
    draft: over.draft ?? (async () => ({ ok: true, value: GOOD_DRAFT })),
    humanActive: over.humanActive ?? (() => false),
    now: over.now ?? (() => new Date("2026-08-15T03:00:00Z")),
  };
}

describe("what the night decides to do, before any money is spent", () => {
  test("an item with shorthand and no brief needs ripening; one with a brief does not", () => {
    // NOT "has the expert ever run": a pass that produced nothing should be
    // retried, and one that produced a brief must not be re-run every night
    // forever, quietly rewriting the packet and appending an event each time.
    expect(needsRipening(item({ id: "a", title: "a", raw: "x", project: "p" }))).toBe(true);
    expect(needsRipening(item({ id: "b", title: "b", raw: "x", fixed: "done", project: "p" }))).toBe(false);
  });

  test("a floating item is never planned — an expert belongs to a project", () => {
    expect(needsRipening(item({ id: "c", title: "c", raw: "x" }))).toBe(false);
    expect(needsDrafting(item({ id: "d", title: "d", fixed: "brief" }))).toBe(false);
  });

  test("A CLOSED ITEM IS NEVER PLANNED — the user ticked the box, so the night has no work there", () => {
    // docs/spool-loops.md §9: closing is the human's own act, and everything
    // downstream of it stops proposing. Ripening or drafting a closed task
    // would spend money briefing something that is over.
    const closed = { closed: { label: "Tue 16:42", at: 1 } };
    expect(needsRipening(item({ id: "a", title: "a", raw: "x", project: "p", ...closed }))).toBe(false);
    expect(needsDrafting(item({ id: "b", title: "b", fixed: "brief", project: "p", ...closed }))).toBe(false);
    const plan = planNight([
      item({ id: "1", title: "live", raw: "r", project: "p" }),
      item({ id: "2", title: "closed", raw: "r", project: "p", ...closed }),
      item({ id: "3", title: "closed briefed", fixed: "b", project: "p", ...closed }),
    ]);
    expect(plan.map((j) => j.itemId)).toEqual(["1"]);
  });

  test("drafting requires a BRIEF, never a bare title", () => {
    // An approach proposed from shorthand is the invention the expert exists to
    // prevent, and it would arrive with the same confidence as a good one.
    expect(needsDrafting(item({ id: "e", title: "e", project: "p" }))).toBe(false);
    expect(needsDrafting(item({ id: "f", title: "f", fixed: "brief", project: "p" }))).toBe(true);
    expect(needsDrafting(item({ id: "g", title: "g", fixed: "brief", draft: "already", project: "p" }))).toBe(false);
  });

  test("EVERY ripening comes before ANY drafting", () => {
    /**
     * THE VALUE-IF-INTERRUPTED RULE, and it is the ordering decision the whole
     * design turns on. A night cut short after the ripening has turned every
     * fragment into a brief. One cut short after the drafting has elaborate
     * approaches attached to items whose shorthand is still shorthand.
     */
    const plan = planNight([
      item({ id: "1", title: "has brief", fixed: "b", project: "p" }),
      item({ id: "2", title: "shorthand", raw: "r", project: "p" }),
      item({ id: "3", title: "has brief too", fixed: "b", project: "p" }),
      item({ id: "4", title: "more shorthand", raw: "r", project: "p" }),
    ]);
    expect(plan.map((j) => j.kind)).toEqual(["ripen", "ripen", "draft", "draft"]);
  });

  test("the plan names no clock and invents no priority", () => {
    // There is nothing to sort by that would not be a clock, and a priority
    // field would be structure the user never asked for.
    const plan = planNight([item({ id: "1", title: "a", raw: "r", project: "p" })]);
    expect(JSON.stringify(plan)).not.toMatch(/\b20\d\d-\d\d-\d\d\b|priority|score|urgency/);
  });
});

describe("the draft prompt", () => {
  test("it asks for concepts, states that nothing will start, and names no date", () => {
    const prompt = draftPrompt(item({ id: "a", title: "Retry the import", fixed: "Add a retry.", project: "aurora" }));

    expect(prompt).toContain("concepts and sequence");
    expect(prompt).toContain("You are not starting this work");
    expect(prompt).toContain("You do not know what today is");
    expect(prompt).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });
});

describe("a night that runs to the end", () => {
  test("it ripens, drafts, and reports itself done", async () => {
    seedRaw("import flakes");
    createItem(paths, { title: "already briefed", provenance: "typed", project: "aurora" });
    // Give the second item a brief so it plans a draft rather than a ripen.
    const briefed = listOne("already briefed");
    writeBrief(briefed.id);

    const night = await runNight(paths, deps());

    expect(night.state).toBe("done");
    expect(night.stop?.reason).toBe("nothing-to-do");
    expect(night.jobs.map((j) => j.state)).toEqual(["done", "done"]);
  });

  test("a draft lands on the packet as a PROPOSAL, beside the brief and never over it", async () => {
    const seeded = createItem(paths, { title: "retry the import", provenance: "typed", project: "aurora" });
    writeBrief(seeded.id, "Add a retry to the nightly import.");

    await runNight(paths, deps());

    const after = getSpoolItem(paths, seeded.id)!;
    expect(after.draft).toContain("Read the importer");
    // The brief survives untouched — a draft is one opinion about HOW, and the
    // brief is what the work IS.
    expect(after.fixed).toBe("Add a retry to the nightly import.");
    const last = after.timeline!.at(-1)!;
    expect(last.actor).toBe("bed");
    expect(last.proposal).toBe(true);
  });

  /**
   * THE QUESTIONS TRAVEL AS DATA; THE RISKS DO NOT — and the asymmetry is the
   * point rather than an inconsistency.
   *
   * A risk is a qualification on the approach and reads correctly beneath it. A
   * question is addressed to the USER, and `docs/spool-definition.md` §8 names
   * "the question it could not answer alone" as one of the things the morning
   * has to show in one screen. A surface cannot lead with what only exists
   * inside a paragraph, so both halves are asserted here: a later tidy-up that
   * re-flattened the questions, or one that pulled the risks out too, breaks a
   * named test rather than a rendering nobody re-checks.
   */
  test("open questions survive as data, and risks stay in the prose", async () => {
    const seeded = createItem(paths, { title: "retry the import", provenance: "typed", project: "aurora" });
    writeBrief(seeded.id, "Add a retry to the nightly import.");

    await runNight(paths, deps());

    const after = getSpoolItem(paths, seeded.id)!;
    expect(after.openQuestions).toEqual(["is three attempts enough?"]);
    expect(after.draft).toContain("What could go wrong:\n- the vendor may rate limit us too");
    expect(after.draft).not.toContain("is three attempts enough?");
    expect(after.draft).not.toContain("What it would need to know first");
  });

  /** Absent rather than `[]`: "asked nothing" and "was never asked" render the
   *  same, and neither needs a key on disk. */
  test("a draft that asked nothing writes no empty list", async () => {
    const seeded = createItem(paths, { title: "retry the import", provenance: "typed", project: "aurora" });
    writeBrief(seeded.id, "Add a retry to the nightly import.");

    await runNight(paths, deps({ draft: async () => ({ ok: true, value: { ...GOOD_DRAFT, openQuestions: [] } }) }));

    expect(getSpoolItem(paths, seeded.id)!.openQuestions).toBeUndefined();
  });

  test("a night with nothing to do says so without spending anything", async () => {
    let calls = 0;
    const night = await runNight(paths, deps({ ripen: async () => { calls++; throw new Error("unreachable"); } }));

    expect(night.state).toBe("done");
    expect(night.stop?.reason).toBe("nothing-to-do");
    expect(calls).toBe(0);
  });
});

describe("stopping", () => {
  test("a rate limit stops the night and leaves the job PENDING", async () => {
    /**
     * THE CASE THE WHOLE DESIGN IS FOR. A rate limit says nothing about this
     * item, so marking it failed would silently drop real work — the next run
     * would never look at it again.
     */
    seedRaw("one");
    seedRaw("two");
    const night = await runNight(
      paths,
      deps({ ripen: async () => ({ ok: false, reason: "expert:aurora: the account is rate limited (429). Nothing was written." }) }),
    );

    expect(night.state).toBe("stopped");
    expect(night.stop?.reason).toBe("rate-limited");
    expect(night.jobs.every((j) => j.state === "pending")).toBe(true);
  });

  test("a rate limit stops on the FIRST one rather than walking the queue", async () => {
    // A rate limit is about the account, so every remaining item would fail
    // identically. Walking on would burn a request per item to relearn it.
    seedRaw("one");
    seedRaw("two");
    seedRaw("three");
    let calls = 0;
    await runNight(paths, deps({ ripen: async () => { calls++; return { ok: false, reason: "the account is rate limited" }; } }));

    expect(calls).toBe(1);
  });

  test("the human coming back stands the night down, before the next job runs", async () => {
    seedRaw("one");
    seedRaw("two");
    let calls = 0;
    const night = await runNight(
      paths,
      deps({
        humanActive: () => calls >= 1,
        ripen: async () => { calls++; return { ok: true, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] }, cold: false }; },
      }),
    );

    expect(night.stop?.reason).toBe("human-active");
    // One ran, the second never started: the check is BEFORE the job, so the
    // account is yielded rather than competed for.
    expect(calls).toBe(1);
    expect(night.jobs.filter((j) => j.state === "pending")).toHaveLength(1);
  });

  test("the job ceiling stops it without overshooting by one", async () => {
    // Checked before the job, never after — checking afterwards spends the call
    // it was meant to prevent, every time.
    for (const n of ["a", "b", "c", "d"]) seedRaw(n);
    let calls = 0;
    const night = await runNight(paths, deps({ ripen: async () => { calls++; return { ok: true, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] }, cold: false }; } }), { maxJobs: 2 });

    expect(calls).toBe(2);
    expect(night.stop?.reason).toBe("budget");
  });

  test("repeated failures stop the night rather than working through the rest to find the same fault", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) seedRaw(n);
    let calls = 0;
    const night = await runNight(
      paths,
      deps({ ripen: async () => { calls++; return { ok: false, reason: "the model exploded" }; } }),
      { maxConsecutiveFailures: 2 },
    );

    expect(night.stop?.reason).toBe("failing");
    expect(calls).toBe(2);
  });

  test("a success resets the failure streak, so an unlucky item does not end the night", async () => {
    for (const n of ["a", "b", "c"]) seedRaw(n);
    let calls = 0;
    const night = await runNight(
      paths,
      deps({
        ripen: async () => {
          calls++;
          if (calls === 1) return { ok: false, reason: "one bad item" };
          return { ok: true, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] }, cold: false };
        },
      }),
      { maxConsecutiveFailures: 2 },
    );

    expect(night.state).toBe("done");
    expect(calls).toBe(3);
  });

  test("a floating item is REFUSED, not failed, and does not count toward giving up", async () => {
    /**
     * THE DISTINCTION THAT MAKES THE MORNING REPORT WORTH READING. A refusal is
     * the system working and telling you the one thing only you can do. Counting
     * it as a failure would end a night that went fine.
     */
    for (const n of ["a", "b", "c"]) seedRaw(n);
    const night = await runNight(
      paths,
      deps({ ripen: async () => ({ ok: false, reason: '"a" is floating — it belongs to no project.' }) }),
      { maxConsecutiveFailures: 2 },
    );

    expect(night.jobs.map((j) => j.state)).toEqual(["refused", "refused", "refused"]);
    expect(night.stop?.reason).toBe("nothing-to-do");
  });

  test("every stop carries a sentence, never a bare code", async () => {
    seedRaw("one");
    const night = await runNight(paths, deps({ humanActive: () => true }));

    expect(night.stop?.note).toBeTruthy();
    expect(night.stop!.note.length).toBeGreaterThan(20);
  });
});

describe("resuming", () => {
  test("a stopped night is continued, not restarted — finished work is never redone", async () => {
    for (const n of ["a", "b", "c"]) seedRaw(n);
    let calls = 0;
    const ok = async () => {
      calls++;
      return { ok: true as const, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] }, cold: false };
    };

    const first = await runNight(paths, deps({ ripen: ok }), { maxJobs: 1 });
    expect(first.stop?.reason).toBe("budget");
    expect(calls).toBe(1);

    const second = await runNight(paths, deps({ ripen: ok }));
    expect(second.state).toBe("done");
    // Two more calls, not four: the first job was already done.
    expect(calls).toBe(3);
    expect(second.id).toBe(first.id);
  });

  test("a FINISHED night is not resumed — its work would be redone", async () => {
    const seeded = seedRaw("one");
    /**
     * THE STUB HAS TO WRITE, or the scenario is not the one being tested. A real
     * pass sets `fixed`, which is exactly what makes the item stop needing a
     * ripen; a stub that only REPORTS success leaves the item unchanged, and the
     * next night re-plans it — correctly, and for a reason that has nothing to
     * do with resumption.
     */
    const first = await runNight(paths, deps({ ripen: async (id) => { writeBrief(id); return okPass(); } }));
    expect(first.state).toBe("done");

    /**
     * THE NEXT RUN OPENS A FRESH NIGHT AND RE-PLANS FROM DISK, rather than
     * replaying the settled one. The plan it computes is a DRAFT, not a second
     * ripen — which is the honest proof that selection reads the store's current
     * state instead of the last night's record: the item now has a brief, so the
     * work it needs has changed.
     */
    const second = await runNight(paths, deps());
    expect(second.id).not.toBe(first.id);
    expect(second.jobs.map((j) => j.kind)).toEqual(["draft"]);
    // The settled ripen is nowhere in the new night — it is not re-run.
    expect(second.jobs.some((j) => j.itemId === seeded.id && j.kind === "ripen")).toBe(false);
    // …and the brief the first night wrote is still there, untouched.
    expect(getSpoolItem(paths, seeded.id)?.fixed).toBe("A brief.");
  });

  test("the record is on disk after EVERY job, so a crash costs at most one", async () => {
    for (const n of ["a", "b", "c"]) seedRaw(n);
    const seen: number[] = [];
    await runNight(
      paths,
      deps({
        ripen: async () => {
          // Read the record from disk mid-run: what is there is what a crash
          // right now would leave behind.
          seen.push(readNight(paths)?.jobs.filter((j) => j.state !== "pending").length ?? -1);
          return { ok: true, project: "aurora", applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" }, digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] }, cold: false };
        },
      }),
    );

    // Before job 1 nothing is settled; before job 2 exactly one is; and so on.
    expect(seen).toEqual([0, 1, 2]);
  });

  test("an unreadable night record starts a fresh one rather than refusing to run", async () => {
    // It is a run record, not the user's data. Their packets are untouched
    // either way, so the honest recovery is to carry on.
    seedRaw("one");
    fs.writeFileSync(path.join(paths.root, "night.json"), "{ not json");

    const night = await runNight(paths, deps());
    expect(night.jobs).toHaveLength(1);
  });
});

describe("what it cost", () => {
  test("usage totals across the night, and absent stays absent", async () => {
    seedRaw("a");
    seedRaw("b");
    let n = 0;
    const night = await runNight(
      paths,
      deps({
        ripen: async () => {
          n++;
          return {
            ok: true,
            project: "aurora",
            applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" },
            digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] },
            cold: false,
            usage: { tokens: { input: 100, output: 10, cacheRead: 0, cacheCreate: 0 }, ...(n === 1 ? { costUsd: 0.01 } : {}) },
          };
        },
      }),
    );

    expect(night.usage?.tokens.input).toBe(200);
    // One reported a cost and one did not. The total is what was reported, not
    // a figure that counted the unknown as zero and understated the night.
    expect(night.usage?.costUsd).toBe(0.01);
  });

  test("the spend ceiling stops the night", async () => {
    for (const n of ["a", "b", "c", "d"]) seedRaw(n);
    const night = await runNight(
      paths,
      deps({
        ripen: async () => ({
          ok: true,
          project: "aurora",
          applied: { item: item({ id: "x", title: "x" }), events: 1, commitments: 0, at: "Fri" },
          digest: { project: "aurora", schemaVersion: 1, updated: "Fri", summary: "", methodology: "", glossary: [], notes: [] },
          cold: false,
          usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, costUsd: 0.5 },
        }),
      }),
      { maxCostUsd: 1 },
    );

    expect(night.stop?.reason).toBe("budget");
    // Two jobs at 0.50 reaches the ceiling; the third never starts.
    expect(night.jobs.filter((j) => j.state === "done")).toHaveLength(2);
  });
});

// ── helpers that touch the store directly ───────────────────────────────────

function listOne(title: string): SpoolItem {
  const found = fs
    .readdirSync(path.join(paths.root, "packets"))
    .map((id) => getSpoolItem(paths, id))
    .find((candidate) => candidate?.title === title);
  if (!found) throw new Error(`no item titled ${title}`);
  return found;
}

/** Writes a brief the way an expert pass would, so a draft job can be planned
 *  without running one. */
function writeBrief(id: string, fixed = "A brief."): void {
  const file = path.join(paths.root, "packets", id, "packet.json");
  const packet = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...packet, fixed }, null, 2));
}

describe("it cannot keep digging", () => {
  test("the plan is FROZEN at open — work that becomes eligible mid-night waits", async () => {
    /**
     * THE BOUND THAT MAKES "NO BUDGET" SAFE. Ripening an item sets `fixed`,
     * which immediately makes it eligible for a draft. If the night re-planned
     * as it went, every ripen would breed a draft and the queue would grow while
     * being worked — the exact "always finds more to do" failure.
     */
    const seeded = seedRaw("one");
    const night = await runNight(paths, deps({ ripen: async (id) => { writeBrief(id); return okPass(); } }));

    expect(night.jobs).toHaveLength(1);
    expect(night.jobs[0]!.kind).toBe("ripen");
    // The draft it made eligible is NOT in this night, though it is real work.
    expect(night.jobs.some((j) => j.kind === "draft")).toBe(false);
    expect(getSpoolItem(paths, seeded.id)?.fixed).toBe("A brief.");
  });

  test("an item created while the night runs is not adopted into it", async () => {
    // Same bound from the other side: the store growing under the runner does
    // not lengthen the run in flight.
    seedRaw("one");
    const night = await runNight(
      paths,
      deps({
        ripen: async () => {
          seedRaw("smuggled in mid-run");
          return okPass();
        },
      }),
    );

    expect(night.jobs).toHaveLength(1);
  });

  test("no job kind can create an item — the night never grows the queue", async () => {
    /**
     * THE CONSERVATION LAW, ASSERTED AGAINST THE RUNNER RATHER THAN THE STORE.
     * The store already refuses agent promotion; this proves the night has no
     * other route to one either.
     */
    for (const n of ["a", "b", "c"]) seedRaw(n);
    const before = fs.readdirSync(path.join(paths.root, "packets")).length;

    await runNight(paths, deps({ ripen: async (id) => { writeBrief(id); return okPass(); } }));

    expect(fs.readdirSync(path.join(paths.root, "packets")).length).toBe(before);
  });

  test("run it over and over and it CONVERGES — the queue drains instead of regenerating", async () => {
    /**
     * THE WHOLE WORRY, AS A TEST. Every job kind is terminal for the item it
     * touches, so a store nobody adds to reaches `nothing-to-do` and stays
     * there. If a predicate ever stopped excluding what its own job produced,
     * this loop would not terminate — which is exactly the failure it exists to
     * catch, and why the bound is asserted rather than described.
     */
    for (const n of ["a", "b", "c"]) seedRaw(n);
    const ripen = async (id: string) => { writeBrief(id); return okPass(); };

    const states: string[] = [];
    for (let run = 0; run < 6; run++) {
      const night = await runNight(paths, deps({ ripen }));
      states.push(`${night.state}:${night.jobs.length}`);
    }

    // Night 1 ripens three. Night 2 drafts three. Every night after has nothing
    // left to find, forever.
    expect(states).toEqual(["done:3", "done:3", "done:0", "done:0", "done:0", "done:0"]);
  });

  test("with no ceiling set, the item count is the ceiling", async () => {
    // "No budget" is bounded by the store rather than unbounded — the frozen
    // plan is the real limit, and this is what that means in practice.
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) seedRaw(n);
    let calls = 0;
    const night = await runNight(paths, deps({ ripen: async (id) => { calls++; writeBrief(id); return okPass(); } }));

    expect(calls).toBe(7);
    expect(night.stop?.reason).toBe("nothing-to-do");
  });

  test("a fault stop still holds with no budget — a broken thing does not run all night", async () => {
    // The one ceiling that stays on by default, and it is not a budget: "the
    // same thing is broken every time" is not worth paying to rediscover.
    for (const n of ["a", "b", "c", "d", "e", "f", "g"]) seedRaw(n);
    let calls = 0;
    const night = await runNight(paths, deps({ ripen: async () => { calls++; return { ok: false, reason: "the model exploded" }; } }));

    expect(night.stop?.reason).toBe("failing");
    expect(calls).toBe(3);
  });
});

/**
 * STOPPING OVERNIGHT WORK — found by driving it, not by the gate.
 *
 * The morning report grew a stop button on running jobs, and the night handed
 * its watcher no `AbortController`, so the button was live and inert. That is
 * the same class of defect as the panel toggle that opened a panel `display:
 * none` could never show — a control that silently does nothing.
 */
describe("a night can be stopped, and a stop is not a failure", () => {
  test("every job hands its controller to the watcher", async () => {
    /**
     * THE LIVE DEPS ARE WHAT WIRE IT, so they are what is driven — every other
     * test in this file injects past `nightDeps` by design, which is exactly
     * how the missing controller went unnoticed.
     *
     * THE SUBJECT IS DELIBERATELY UNADDRESSABLE ("My Project" has a space), so
     * `runExpertPass` refuses on the name before it invokes anything. `watch`
     * is called BEFORE that refusal, which is the whole claim, and the test
     * spends nothing to prove it.
     */
    const seeded = createItem(paths, { title: "one", provenance: "typed", project: "My Project", raw: "shorthand" });
    const seen: AbortController[] = [];
    const live = nightDeps(paths, {
      humanActive: () => false,
      cwdFor: () => undefined,
      watch: (input) => {
        seen.push(input.abort);
        return { step: () => undefined, settle: () => undefined };
      },
    });

    const outcome = await live.ripen(seeded.id);
    expect(outcome.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortController);
  });

  test("a job you stopped is REFUSED, so three stops do not read as three faults", async () => {
    /**
     * IT MATTERS TWICE. A red triangle for a thing you chose is a lie on the
     * report — and `failed` increments the consecutive-failure counter, so
     * three deliberate stops would have halted the night with "3 items failed
     * in a row" about a night nobody had any trouble with. `refused` resets it.
     */
    for (const n of ["a", "b", "c", "d"]) seedRaw(n);
    const night = await runNight(
      paths,
      deps({
        ripen: async () => ({ ok: false, reason: "expert:aurora: the call was cancelled; nothing was written." }),
      }),
    );

    expect(night.jobs.map((j) => j.state)).toEqual(["refused", "refused", "refused", "refused"]);
    // It ran the whole queue rather than halting on a fault that was not one.
    expect(night.stop?.reason).toBe("nothing-to-do");
  });

  test("a draft you stopped is refused too, and writes nothing", async () => {
    const seeded = createItem(paths, { title: "retry the import", provenance: "typed", project: "aurora" });
    writeBrief(seeded.id, "Add a retry to the nightly import.");

    const night = await runNight(
      paths,
      deps({
        draft: async () => ({
          ok: false,
          kind: "aborted",
          reason: "draft:aurora: the call was cancelled; nothing was written.",
        }),
      }),
    );

    expect(night.jobs[0]!.state).toBe("refused");
    expect(getSpoolItem(paths, seeded.id)?.draft).toBeUndefined();
  });
});

/**
 * MAINTENANCE IS A JOB KIND, and it goes last.
 *
 * The value-if-interrupted rule deciding again: a night cut short after only
 * VERIFYING has tidied what the assistant believes and shown the user nothing.
 * The counter-argument — that drafting on an unchecked fact can produce a stale
 * approach — is real and loses, because a draft is a proposal nobody accepted
 * while a night with nothing visible is indistinguishable from one that never
 * ran.
 */
describe("the verify job in the plan", () => {
  const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
    provenance: "typed",
    captured: "Fri 22:00",
    schemaVersion: 1,
    ...over,
  });

  const shorthand = item({ id: "i-1", title: "raw", project: "ozom-gv", raw: "x" });
  const briefed = item({ id: "i-2", title: "briefed", project: "ozom-gv", fixed: "a brief" });

  test("it is planned after every ripen and every draft", () => {
    const plan = planNight([shorthand, briefed], () => true, ["ozom-gv"]);
    expect(plan.map((j) => j.kind)).toEqual(["ripen", "draft", "verify"]);
  });

  /** It reads a tree and proposes nothing, which is the floor's definition —
   *  so `read` is the level it needs, not `draft`. */
  test("a subject at `read` is still verified", () => {
    const plan = planNight([], (_s, level) => level === "read", ["ozom-gv"]);
    expect(plan.map((j) => j.kind)).toEqual(["verify"]);
  });

  test("a verify job names a SUBJECT and no item", () => {
    const [job] = planNight([], () => true, ["ozom-gv"]);
    expect(job!.subject).toBe("ozom-gv");
    expect(job!.itemId).toBeUndefined();
  });

  /** A caller that has not been updated plans no verify jobs rather than
   *  failing every one of them. */
  test("with nothing verifiable, nothing is planned", () => {
    expect(planNight([shorthand], () => true).map((j) => j.kind)).toEqual(["ripen"]);
  });
});

describe("running a verify job", () => {
  /** The job's `itemId` is absent, so the loop must not treat it as an item that
   *  went away — which is what it did before the lookup moved inside the branch. */
  test("it runs without an item, and reports what moved", async () => {
    createItem(paths, { title: "unrelated", provenance: "typed", project: "aurora" });
    // A subject with NO digest is refused rather than reported done — there is
    // no memory to check — so the job needs one to have anything to say.
    writeExpertDigest(paths, {
      project: "ozom-gv",
      schemaVersion: 1,
      updated: "Fri 22:00",
      summary: "",
      methodology: "",
      glossary: [],
      facts: [{ id: "f-1", text: "a claim", kind: "howItWorks", source: { pass: "Fri 22:00" } }],
    });
    const night = await runNight(paths, {
      ...deps(),
      verifiable: () => ["ozom-gv"],
      verify: async () => ({
        ok: true,
        head: "abc123",
        value: { checked: [], note: "checked three claims" },
      }),
    });

    expect(night.jobs.map((j) => j.kind)).toContain("verify");
    const verify = night.jobs.find((j) => j.kind === "verify")!;
    expect(verify.state).toBe("done");
    expect(verify.itemId).toBeUndefined();
  });

  /** School and a client engagement are subjects with no repository — the
   *  ORDINARY case, not a fault, so it must not read as one. */
  test("a subject with no checkout is REFUSED, not failed", async () => {
    const night = await runNight(paths, {
      ...deps(),
      verifiable: () => ["school"],
      verify: async () => ({
        ok: false,
        kind: "unavailable",
        reason: "school has no checkout on this machine, so there is nothing to check its memory against.",
      }),
    });

    expect(night.jobs.find((j) => j.kind === "verify")!.state).toBe("refused");
    // And a refusal resets the failure streak rather than counting toward the halt.
    expect(night.stop?.reason).toBe("nothing-to-do");
  });

  test("with no verifier wired at all, the job refuses rather than throwing", async () => {
    const night = await runNight(paths, { ...deps(), verifiable: () => ["ozom-gv"] });
    expect(night.jobs.find((j) => j.kind === "verify")!.state).toBe("refused");
  });
});

/** A subject nothing has ever read has no memory to check. Not a fault — the
 *  first expert pass is what creates one. */
describe("verifying a subject with no memory", () => {
  test("it is refused, and says so", async () => {
    const night = await runNight(paths, {
      ...deps(),
      verifiable: () => ["never-read"],
      verify: async () => ({ ok: true, head: "abc123", value: { checked: [], note: "" } }),
    });
    const job = night.jobs.find((j) => j.kind === "verify")!;
    expect(job.state).toBe("refused");
    expect(job.note).toContain("no memory to check");
  });
});

/**
 * THE NIGHT'S QUESTIONS ARE THE NIGHT'S OWN RECORD.
 *
 * `NightSurface` derived these by filtering `SpoolDeskCard[]`, which made the
 * morning report a second renderer of the DESK's projection — two surfaces
 * drawing one fact, and the night showing questions from passes it never ran.
 * `runDraft` had produced them all along and the job record dropped them.
 */
describe("a job carries what it could not answer", () => {
  test("SpoolNightJob accepts openQuestions and they survive a write/read", () => {
    const job = SpoolNightJob.parse({
      id: "j-1",
      kind: "draft",
      itemId: "i-a",
      title: "hito 1 cierra en dos semanas",
      state: "done",
      note: "Drafted the method.",
      openQuestions: ["Is the milestone's exact title literally \"Hito 1\"?"],
    });
    expect(job.openQuestions).toHaveLength(1);
  });

  test("a job with nothing unanswered simply has none, rather than an empty array", () => {
    const job = SpoolNightJob.parse({ id: "j-2", kind: "ripen", title: "x", state: "done" });
    expect(job.openQuestions).toBeUndefined();
  });
});
