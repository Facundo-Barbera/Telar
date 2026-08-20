/**
 * Reconcile-on-look — the deterministic, model-free half of loop 1.
 *
 * EVERY TEST INJECTS THE RUNNER. Nothing in this file shells out: the seam is
 * `LookRunner`, and driving it with canned `gh` answers is what proves the
 * observations are a DIFF and not a model's opinion — the same two world
 * states produce the same sentences, every time.
 *
 * The other property this suite owns is honesty at the edges: a first look is
 * a baseline and not a flood, a gh failure is a stale answer and never a
 * throw, a terrain-less subject is a note and never an error, and "noted"
 * drains without deleting.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpoolItem, SpoolSubject, SpoolThread } from "@telar/engine-client";
import {
  acknowledgeObservation,
  digestObservations,
  lookArgs,
  lookPath,
  observe,
  parseWorldRows,
  readLook,
  reconcileLook,
  storedLookOutcome,
  type LookRunner,
  type WorldState,
} from "../src/spool/looks";
import { composeBriefing } from "../src/spool/briefing";
import { ensureSubject, setSubjectTerrain } from "../src/spool/subjects";
import { ensureSpool, spoolPaths, type SpoolPaths } from "../src/spool/store";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-looks-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

let paths: SpoolPaths;
let seq = 0;

beforeEach(() => {
  const engineRoot = path.join(ROOT, `run-${++seq}`);
  fs.mkdirSync(engineRoot, { recursive: true });
  paths = spoolPaths(engineRoot);
  ensureSpool(paths);
});

/** A gh row exactly as `gh … list --json` spells it. */
const ghIssue = (over: Partial<Record<string, unknown>> & { number: number }) => ({
  title: `issue ${over.number}`,
  state: "OPEN",
  updatedAt: "2026-08-15T10:00:00Z",
  url: `https://github.com/ozom-ai/ozom-gv/issues/${over.number}`,
  milestone: null,
  assignees: [],
  author: { login: "ana" },
  ...over,
});

const ghPull = (over: Partial<Record<string, unknown>> & { number: number }) => ({
  ...ghIssue(over),
  title: over.title ?? `pr ${over.number}`,
  url: `https://github.com/ozom-ai/ozom-gv/pull/${over.number}`,
});

/** A runner answering both list calls from two canned payloads. */
const ghOk =
  (issues: unknown[], pulls: unknown[]): LookRunner =>
  async (args) => ({ status: 0, stdout: JSON.stringify(args[0] === "issue" ? issues : pulls), stderr: "" });

const subjectWithTerrain = (): SpoolSubject => {
  ensureSubject(paths, "ozom-gv");
  return setSubjectTerrain(paths, "ozom-gv", { kind: "github-repo", repo: "ozom-ai/ozom-gv" })!;
};

const world = (issues: unknown[], pulls: unknown[]): WorldState => ({
  issues: parseWorldRows("issue", JSON.stringify(issues)),
  pulls: parseWorldRows("pull", JSON.stringify(pulls)),
});

describe("the diff grammar", () => {
  test("a merged PR since the last look", () => {
    const before = world([], [ghPull({ number: 420, state: "OPEN" })]);
    const after = world([], [ghPull({ number: 420, state: "MERGED" })]);
    const deltas = observe(before, after);
    expect(deltas.map((d) => d.text)).toEqual(["PR #420 merged since your last look."]);
    expect(deltas[0]!.refs).toEqual([
      { kind: "pull", number: 420, url: "https://github.com/ozom-ai/ozom-gv/pull/420", title: "pr 420" },
    ]);
  });

  test("a new issue names its opener, its milestone, and that nobody has it", () => {
    const before = world([], []);
    const after = world([ghIssue({ number: 427, title: "identidad", milestone: { title: "Hito 1" } })], []);
    expect(observe(before, after).map((d) => d.text)).toEqual([
      'ana opened #427 ("identidad") and added it to Hito 1. It\'s unassigned.',
    ]);
  });

  test("an assigned new issue does not claim to be unassigned", () => {
    const after = world([ghIssue({ number: 428, assignees: [{ login: "diego" }] })], []);
    const [delta] = observe(world([], []), after);
    expect(delta!.text).not.toContain("unassigned");
  });

  test("review movement on an open PR — comments and approval, nothing subtler", () => {
    const before = world(
      [],
      [ghPull({ number: 423, reviewDecision: "" }), ghPull({ number: 424, reviewDecision: "" })],
    );
    const after = world(
      [],
      [ghPull({ number: 423, reviewDecision: "CHANGES_REQUESTED" }), ghPull({ number: 424, reviewDecision: "APPROVED" })],
    );
    expect(observe(before, after).map((d) => d.text)).toEqual([
      "PR #423 got review comments.",
      "PR #424 was approved.",
    ]);
  });

  test("a closed issue ties back to the item that files it — the spool half of the diff", () => {
    const items = [
      { id: "i-1", title: "tools de escritura", mirrored: "#412", provenance: "session", captured: "Fri", schemaVersion: 1 },
    ] as SpoolItem[];
    const before = world([ghIssue({ number: 412 }), ghIssue({ number: 41 })], []);
    const after = world([ghIssue({ number: 412, state: "CLOSED" }), ghIssue({ number: 41, state: "CLOSED" })], []);
    const texts = observe(before, after, items).map((d) => d.text);
    // #412 is bounded — the item mirroring #412 must not claim #41's movement.
    expect(texts).toEqual([
      '#412 closed since your last look. You file it as "tools de escritura".',
      "#41 closed since your last look.",
    ]);
  });

  test("the same two worlds always say the same thing — deterministic, no clock, no model", () => {
    const before = world([ghIssue({ number: 1 })], [ghPull({ number: 2, state: "OPEN" })]);
    const after = world([ghIssue({ number: 1, state: "CLOSED" })], [ghPull({ number: 2, state: "MERGED" })]);
    expect(observe(before, after)).toEqual(observe(before, after));
  });
});

describe("reconcile-on-look", () => {
  test("the FIRST look records a baseline and does not flood", async () => {
    const subject = subjectWithTerrain();
    const run = ghOk(
      [ghIssue({ number: 401 }), ghIssue({ number: 402 }), ghIssue({ number: 403, state: "CLOSED" })],
      [ghPull({ number: 420, state: "OPEN" })],
    );
    const outcome = await reconcileLook(paths, subject, { run, now: new Date("2026-08-16T07:40:00") });

    expect(outcome.fresh).toBe(true);
    // ONE line, not 29 spurious "new issue" lines — there was no prior look to
    // diff against, so the world becomes the baseline and says so.
    expect(outcome.look!.observations.map((o) => o.text)).toEqual([
      "First look at ozom-ai/ozom-gv — baseline recorded: 2 open issues, 1 open pull request.",
    ]);
    // The raw world is stored, because it IS the next look's baseline.
    expect(outcome.look!.world.issues.map((r) => r.number)).toEqual([401, 402, 403]);
    expect(readLook(paths, "ozom-gv")!.lastLooked).toBe(outcome.look!.lastLooked);
  });

  test("the second look diffs against the baseline and APPENDS observations", async () => {
    const subject = subjectWithTerrain();
    await reconcileLook(paths, subject, { run: ghOk([ghIssue({ number: 401 })], [ghPull({ number: 420 })]) });

    const outcome = await reconcileLook(paths, subject, {
      run: ghOk([ghIssue({ number: 401 }), ghIssue({ number: 427 })], [ghPull({ number: 420, state: "MERGED" })]),
    });

    const texts = outcome.look!.observations.map((o) => o.text);
    // The baseline line survives — observations append, they are never rewritten.
    expect(texts[0]).toContain("baseline recorded");
    expect(texts).toContain("PR #420 merged since your last look.");
    expect(texts.some((t) => t.includes("opened #427"))).toBe(true);
    // …and the world moved to the new baseline, so a THIRD identical look says nothing new.
    const third = await reconcileLook(paths, subject, {
      run: ghOk([ghIssue({ number: 401 }), ghIssue({ number: 427 })], [ghPull({ number: 420, state: "MERGED" })]),
    });
    expect(third.look!.observations).toHaveLength(outcome.look!.observations.length);
  });

  test("gh failing returns the STALE look with an honest error — never a throw, nothing rewritten", async () => {
    const subject = subjectWithTerrain();
    await reconcileLook(paths, subject, { run: ghOk([ghIssue({ number: 401 })], []) });
    const before = fs.readFileSync(lookPath(paths, "ozom-gv"), "utf8");

    const offline: LookRunner = async () => ({ status: 1, stdout: "", stderr: "error connecting to api.github.com" });
    const outcome = await reconcileLook(paths, subject, { run: offline });

    expect(outcome.fresh).toBe(false);
    expect(outcome.error).toContain("Could not look at ozom-ai/ozom-gv");
    expect(outcome.error).toContain("error connecting");
    // The stale look is still the answer — the room renders its staleness.
    expect(outcome.look!.world.issues.map((r) => r.number)).toEqual([401]);
    expect(fs.readFileSync(lookPath(paths, "ozom-gv"), "utf8")).toBe(before);
  });

  test("gh missing and gh signed out are named as themselves", async () => {
    const subject = subjectWithTerrain();
    const missing: LookRunner = async () => ({ status: 127, stdout: "", stderr: "" });
    expect((await reconcileLook(paths, subject, { run: missing })).error).toContain("not installed");
    const signedOut: LookRunner = async () => ({ status: 1, stdout: "", stderr: "To get started with GitHub CLI, please run: gh auth login" });
    expect((await reconcileLook(paths, subject, { run: signedOut })).error).toContain("gh auth login");
  });

  test("a terrain-less subject is a NOTE, not an error — the no-code test", async () => {
    const subject = ensureSubject(paths, "school");
    const neverCalled: LookRunner = async () => {
      throw new Error("a terrain-less subject must never reach gh");
    };
    const outcome = await reconcileLook(paths, subject, { run: neverCalled });
    expect(outcome).toEqual({ subject: "school", fresh: false, note: expect.stringContaining("no terrain") });
    // …and the stored read says the same thing the reconcile does.
    expect(storedLookOutcome(paths, subject).note).toContain("no terrain");
  });

  test("acknowledge DRAINS — the row stays, marked, and an unknown id answers null", async () => {
    const subject = subjectWithTerrain();
    const { look } = await reconcileLook(paths, subject, { run: ghOk([], []) });
    const id = look!.observations[0]!.id;

    const drained = acknowledgeObservation(paths, "ozom-gv", id);
    expect(drained!.observations).toHaveLength(1); // never deleted
    expect(drained!.observations[0]!.acknowledged).toBe(true);
    expect(readLook(paths, "ozom-gv")!.observations[0]!.acknowledged).toBe(true);

    expect(acknowledgeObservation(paths, "ozom-gv", "o-nothing")).toBeNull();
    expect(acknowledgeObservation(paths, "never-looked", "o-1")).toBeNull();
  });

  test("the gh argv is addressed with -R and asks for closed things too — the diff needs them", () => {
    const args = lookArgs("ozom-ai/ozom-gv");
    expect(args.issues).toContain("-R");
    expect(args.issues[args.issues.indexOf("-R") + 1]).toBe("ozom-ai/ozom-gv");
    expect(args.issues).toContain("all");
    expect(args.pulls.join(" ")).toContain("reviewDecision");
  });
});

describe("the briefing — loop 2's payload, composed with no model", () => {
  const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
    provenance: "session",
    captured: "Tue 16:42",
    schemaVersion: 1,
    ...over,
  });

  test("a ripened packet briefs whole: raw words, brief, threads, and the look delta", async () => {
    const subject = subjectWithTerrain();
    const { look } = await reconcileLook(paths, subject, { run: ghOk([], [ghPull({ number: 420, state: "OPEN" })]) });
    const fresh = (await reconcileLook(paths, subject, { run: ghOk([], [ghPull({ number: 420, state: "MERGED" })]) })).look!;

    const thread: SpoolThread = {
      id: "t-1",
      subject: "ozom-gv",
      question: "Does our ad data match the platforms?",
      handle: "Supermetrics parity",
      items: ["i-1"],
      facts: [],
      waiting: { kind: "person", who: "Ana", note: "owes the live numbers" },
      created: "Tue",
      schemaVersion: 1,
    };
    const briefing = composeBriefing({
      item: item({
        id: "i-1",
        title: "presupuestos sept no cuadran",
        project: "ozom-gv",
        raw: "los presupuestos de sept no cuadran\nrevisar antes del cierre",
        fixed: "Reconcile September budgets against the live tracker before close.",
        acceptance: ["The mismatch is named per platform"],
        openQuestions: ["Which platform diverges?"],
        timeline: [{ at: "Tue 16:42", actor: "expert", text: "wrote the brief", proposal: true }],
      }),
      threads: [thread],
      look: fresh,
      subject,
      project: { id: "project_1", name: "ozom-gv" },
    });

    expect(briefing.project).toEqual({ id: "project_1", name: "ozom-gv" });
    expect(briefing.subject).toBe("ozom-gv");
    // The user's own words, quoted verbatim, both lines.
    expect(briefing.briefing).toContain("> los presupuestos de sept no cuadran");
    expect(briefing.briefing).toContain("> revisar antes del cierre");
    expect(briefing.briefing).toContain("Reconcile September budgets");
    expect(briefing.briefing).toContain("The mismatch is named per platform");
    // Thread state, with who it is stuck on.
    expect(briefing.briefing).toContain("Does our ad data match the platforms?");
    expect(briefing.briefing).toContain("stuck on Ana");
    // The delta, attributed to the look that saw it — a quoted label, never a
    // resolved time (§3.2's quoting law).
    expect(briefing.briefing).toContain(`As of the Spool's look at ${fresh.lastLooked}`);
    expect(briefing.briefing).toContain("PR #420 merged since your last look.");
    expect(briefing.freshness!.looked).toBe(fresh.lastLooked);
    expect(briefing.freshness!.observations.map((o) => o.text)).toContain("PR #420 merged since your last look.");
    // Nothing is claimed to have started.
    expect(briefing.briefing).toContain("Nothing above has been started");
    expect(look).toBeTruthy();
  });

  test("acknowledged observations do not come back in the briefing — noted is noted", async () => {
    const subject = subjectWithTerrain();
    await reconcileLook(paths, subject, { run: ghOk([], []) });
    const fresh = (await reconcileLook(paths, subject, { run: ghOk([ghIssue({ number: 9 })], []) })).look!;
    const baseline = fresh.observations.find((o) => o.text.includes("baseline"))!;
    acknowledgeObservation(paths, "ozom-gv", baseline.id);

    const briefing = composeBriefing({
      item: item({ id: "i-1", title: "x", project: "ozom-gv" }),
      look: readLook(paths, "ozom-gv")!,
      subject,
    });
    expect(briefing.freshness!.observations.map((o) => o.text)).toEqual([
      expect.stringContaining("opened #9"),
    ]);
    expect(briefing.briefing).not.toContain("baseline recorded");
  });

  test("a bare, floating, terrain-less capture still briefs — smaller, never broken", () => {
    const briefing = composeBriefing({ item: item({ id: "i-2", title: "Call María — invoice", raw: "call maría re invoice" }) });
    expect(briefing.project).toBeUndefined();
    expect(briefing.subject).toBeUndefined();
    expect(briefing.freshness).toBeUndefined();
    expect(briefing.briefing).toContain("floating");
    expect(briefing.briefing).toContain("> call maría re invoice");
    expect(briefing.briefing).toContain("No brief has been written yet");
  });
});

describe("the movement digest — compress-never-multiply applied to observations", () => {
  // Everything here is PURE: a stored look, the lanes and the items go in, and
  // the same lines come out every time. No store, no model, no clock.
  const item = (over: Partial<SpoolItem> & { id: string; title: string }): SpoolItem => ({
    provenance: "you",
    captured: "Tue 16:42",
    schemaVersion: 1,
    ...over,
  });
  const observation = (id: string, text: string, refs: Array<{ kind: "issue" | "pull"; number: number }> = []) => ({
    id,
    text,
    refs,
    seen: "Sat 07:40",
    seenAt: 1,
  });
  const lookOf = (observations: ReturnType<typeof observation>[]) => ({
    subject: "ozom-gv",
    schemaVersion: 1,
    lastLooked: "Sat 07:40",
    lastLookedAt: 1,
    world: { issues: [], pulls: [] },
    observations,
  });
  const lane = (key: string, label: string, items: string[]) => ({ key, label, window: "work hours", items });

  test("observations whose refs resolve to ONE lane fold into one line for it — never a row per observation", () => {
    const lanes = [lane("hito-1", "Hito 1 · Agosto", ["i-1", "i-2", "i-3"])];
    const items = [
      item({ id: "i-1", title: "parity", mirrored: "#420", project: "ozom-gv" }),
      item({ id: "i-2", title: "budgets", mirrored: "#421", project: "ozom-gv" }),
      item({ id: "i-3", title: "gate", mirrored: "#412", project: "ozom-gv" }),
    ];
    const digest = digestObservations(
      lookOf([
        observation("o-1", "PR #420 merged since your last look.", [{ kind: "pull", number: 420 }]),
        observation("o-2", "PR #421 merged since your last look.", [{ kind: "pull", number: 421 }]),
        observation("o-3", '#412 closed since your last look. You file it as "gate".', [{ kind: "issue", number: 412 }]),
      ]),
      lanes,
      items,
    );
    // ONE line — the compression is the point.
    expect(digest).toEqual([
      { text: "Hito 1 · Agosto — 2 PRs merged, 1 issue closed", observationIds: ["o-1", "o-2", "o-3"] },
    ]);
  });

  test("no refs, unresolved refs, and refs across two lanes all fold into the subject's residual line, last", () => {
    const lanes = [
      lane("hito-1", "Hito 1 · Agosto", ["i-1"]),
      lane("hito-2", "Hito 2", ["i-2"]),
    ];
    const items = [
      item({ id: "i-1", title: "a", mirrored: "#1", project: "ozom-gv" }),
      item({ id: "i-2", title: "b", mirrored: "#2", project: "ozom-gv" }),
    ];
    const digest = digestObservations(
      lookOf([
        // Straddles two lanes — residual, because it is not ONE lane's news.
        observation("o-1", "PR #1 merged since your last look.", [{ kind: "pull", number: 1 }, { kind: "pull", number: 2 }]),
        // Resolves to nothing filed — residual.
        observation("o-2", "ana opened PR #99 (\"stray\").", [{ kind: "pull", number: 99 }]),
        // No refs at all — the baseline line is the canonical case.
        observation("o-3", "First look at ozom-ai/ozom-gv — baseline recorded: 3 open issues, 1 open pull request."),
        // And one that DOES resolve, to prove the residual sits after it.
        observation("o-4", "PR #2 was approved.", [{ kind: "pull", number: 2 }]),
      ]),
      lanes,
      items,
    );
    expect(digest.map((line) => line.text)).toEqual([
      "Hito 2 — 1 PR approved",
      "ozom-gv — 1 PR merged, 1 PR opened, 1 note",
    ]);
    expect(digest[1]!.observationIds).toEqual(["o-1", "o-2", "o-3"]);
  });

  test("acknowledged observations are already drained and appear in no line; all-acknowledged digests to nothing", () => {
    const lanes = [lane("hito-1", "Hito 1 · Agosto", ["i-1"])];
    const items = [item({ id: "i-1", title: "a", mirrored: "#7", project: "ozom-gv" })];
    const pending = observation("o-1", "PR #7 merged since your last look.", [{ kind: "pull", number: 7 }]);
    const noted = { ...observation("o-2", "PR #7 was approved.", [{ kind: "pull", number: 7 }]), acknowledged: true };
    expect(digestObservations(lookOf([pending, noted]), lanes, items)).toEqual([
      { text: "Hito 1 · Agosto — 1 PR merged", observationIds: ["o-1"] },
    ]);
    expect(digestObservations(lookOf([noted]), lanes, items)).toEqual([]);
    expect(digestObservations(lookOf([]), lanes, items)).toEqual([]);
  });
});
