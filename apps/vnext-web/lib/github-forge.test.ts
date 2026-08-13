/**
 * The display decisions GitHub's vocabulary needs.
 *
 * Every test here is a wrong answer this module exists to avoid giving — a green
 * badge on a pull request whose whole matrix skipped, a merge button disabled on a
 * pull request that merges fine, a failure count that includes a run somebody
 * cancelled on purpose.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  buildForgeTimeline,
  checkHeadline,
  checkSummary,
  issueStatus,
  mergeReadiness,
  MERGE_REFUSAL,
  pullStatus,
  reviewLabel,
  STATUS_LABEL,
  STATUS_TONE,
  UNAVAILABLE,
} from "./github-forge";

const check = (conclusion?: string, status = "COMPLETED") => ({ name: "c", status, ...(conclusion ? { conclusion } : {}) });

describe("checkSummary", () => {
  test("a check with no conclusion is RUNNING, not passing", () => {
    // The bug this prevents: a missing conclusion read as "has not failed", so a
    // pull request mid-CI shows an all-green row.
    const summary = checkSummary([check(undefined, "IN_PROGRESS"), check(undefined, "QUEUED"), check("SUCCESS")]);
    expect(summary).toMatchObject({ running: 2, passed: 1, failed: 0 });
  });

  test("skipped is not a pass, and cancelled is not a failure", () => {
    // A repository whose entire matrix skipped would otherwise report "3 passed",
    // which is the wrong answer to "did CI run". And a run somebody stopped is
    // neither a verdict nor a problem — counting it red puts a failure badge on a
    // pull request with nothing wrong with it.
    const summary = checkSummary([check("SKIPPED"), check("SKIPPED"), check("CANCELLED"), check("NEUTRAL")]);
    expect(summary).toEqual({ total: 4, passed: 0, failed: 0, running: 0, skipped: 2, neutral: 2 });
  });

  test("the four conclusions that are genuinely red", () => {
    const summary = checkSummary([check("FAILURE"), check("TIMED_OUT"), check("ACTION_REQUIRED"), check("STARTUP_FAILURE")]);
    expect(summary.failed).toBe(4);
  });

  test("no checks at all is not the same as everything passing", () => {
    // Which is why the headline is empty rather than "0 failing" — the surface
    // says "no checks ran" in its own words.
    expect(checkSummary([])).toMatchObject({ total: 0 });
    expect(checkHeadline(checkSummary([]))).toBe("");
  });

  test("the headline leads with the bad news", () => {
    expect(checkHeadline(checkSummary([check("FAILURE"), check("SUCCESS"), check(undefined, "IN_PROGRESS")]))).toBe(
      "1 failing · 1 running · 1 passed",
    );
  });
});

describe("mergeReadiness", () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRefName: "main",
    ...over,
  });

  test("clean and open merges, with nothing to add", () => {
    expect(mergeReadiness(pull())).toEqual({ canMerge: true });
  });

  test("mergeability GitHub has not computed is ALLOWED, not refused", () => {
    // GitHub computes it lazily on first ask, so refusing here would disable the
    // button on the first merge of every quiet pull request. Pressing it is what
    // makes GitHub work it out.
    expect(mergeReadiness(pull({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).toMatchObject({ canMerge: true, caution: true });
  });

  test("failing checks that nothing requires are ALLOWED, and named", () => {
    // GitHub allows that merge, so this does too — but a person merging over a red
    // check should have to read that they are.
    const readiness = mergeReadiness(pull({ mergeStateStatus: "UNSTABLE" }));
    expect(readiness.canMerge).toBe(true);
    expect(readiness.note).toContain("none of them are required");
  });

  test("each refusal says who has to do what", () => {
    expect(mergeReadiness(pull({ isDraft: true })).note).toContain("draft");
    expect(mergeReadiness(pull({ mergeable: "CONFLICTING" })).note).toContain("conflicts with main");
    expect(mergeReadiness(pull({ mergeStateStatus: "DIRTY" })).note).toContain("rebase");
    expect(mergeReadiness(pull({ mergeStateStatus: "BLOCKED" })).note).toContain("required review");
    expect(mergeReadiness(pull({ mergeStateStatus: "BEHIND" })).note).toContain("up to date");
    for (const state of ["DRAFT", "BLOCKED", "BEHIND", "DIRTY"]) expect(mergeReadiness(pull({ mergeStateStatus: state })).canMerge).toBe(false);
  });

  test("a closed pull request offers no button and no explanation", () => {
    // The state badge above it already says MERGED or CLOSED; a sentence under a
    // missing button would be explaining something nobody asked.
    expect(mergeReadiness(pull({ state: "MERGED" }))).toEqual({ canMerge: false });
    expect(mergeReadiness(pull({ state: "CLOSED" }))).toEqual({ canMerge: false });
  });
});

describe("issueStatus", () => {
  test("SIX outcomes, not two — done and abandoned are different answers", () => {
    // A list that can show closed rows is a list where "was this done?" is the
    // question every closed row raises, and one word for both would refuse it.
    expect(issueStatus({ state: "OPEN" })).toBe("open");
    expect(issueStatus({ state: "CLOSED", stateReason: "COMPLETED" })).toBe("completed");
    expect(issueStatus({ state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe("abandoned");
    // A duplicate is not getting done either, so it wears the same word.
    expect(issueStatus({ state: "CLOSED", stateReason: "DUPLICATE" })).toBe("abandoned");
    // Closed with no reason at all is neither: GitHub simply did not say.
    expect(issueStatus({ state: "CLOSED" })).toBe("closed");
  });

  test("green is reserved for finishing", () => {
    // Painting every closed thing green would make the app's success colour mean
    // "closed", which the label already says in words.
    expect(STATUS_TONE[issueStatus({ state: "CLOSED", stateReason: "COMPLETED" })]).toBe("done");
    expect(STATUS_TONE[issueStatus({ state: "CLOSED", stateReason: "NOT_PLANNED" })]).toBe("none");
    expect(STATUS_TONE[issueStatus({ state: "OPEN" })]).toBe("active");
    // And nothing here is destructive: a closed issue is not an error, and
    // spending red on an ordinary outcome leaves nothing for a failing check.
    for (const status of ["open", "draft", "merged", "closed", "completed", "abandoned"] as const) {
      expect(STATUS_TONE[status]).not.toBe("danger");
      expect(STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });
});

describe("pullStatus", () => {
  test("merged wins over every other reading", () => {
    // GitHub reports a merged pull request as CLOSED in some shapes and MERGED in
    // others, and `mergedAt` is the fact underneath both.
    expect(pullStatus({ state: "MERGED", isDraft: false })).toBe("merged");
    expect(pullStatus({ state: "CLOSED", isDraft: false, mergedAt: 1 })).toBe("merged");
    expect(pullStatus({ state: "CLOSED", isDraft: false })).toBe("closed");
    expect(pullStatus({ state: "OPEN", isDraft: false })).toBe("open");
  });

  test("a CLOSED draft is closed, not a draft", () => {
    // Calling it a draft would suggest it is still waiting for somebody to finish
    // it, when in fact nobody is going to.
    expect(pullStatus({ state: "CLOSED", isDraft: true })).toBe("closed");
    expect(pullStatus({ state: "OPEN", isDraft: true })).toBe("draft");
  });
});

describe("buildForgeTimeline", () => {
  const comment = (at: number, body = `c${at}`, over: Record<string, unknown> = {}) => ({
    body,
    createdAt: at,
    minimized: false,
    url: `https://gh/c${at}`,
    ...over,
  });
  const review = (at: number, state: string, body = "") => ({ state, body, submittedAt: at, author: "grace" });

  test("a review that ANSWERS a comment lands after it", () => {
    // The defect this fixes: the body, then every review, then every comment, in
    // three sections — so on a pull request where a review answered a comment, the
    // answer appeared above the thing it answered, in a different part of the page.
    const timeline = buildForgeTimeline({
      body: "the ask",
      author: "ada",
      createdAt: 100,
      comments: [comment(300, "what about X?")],
      reviews: [review(200, "CHANGES_REQUESTED", "no"), review(400, "APPROVED", "because Y")],
    });
    expect(timeline.map((entry) => [entry.kind, entry.at])).toEqual([
      ["body", 100],
      ["review", 200],
      ["comment", 300],
      ["review", 400],
    ]);
  });

  test("the body is first even when something shares its timestamp", () => {
    // A bot that comments in the same second the issue is filed would otherwise be
    // able to sort a reply above the thing it replies to.
    const timeline = buildForgeTimeline({ body: "opened", createdAt: 100, comments: [comment(100, "bot"), comment(50, "impossible")] });
    expect(timeline[0]).toMatchObject({ kind: "body", body: "opened" });
  });

  test("an EMPTY `COMMENTED` review is dropped — it is not an event", () => {
    // GitHub creates one every time somebody leaves inline comments on the diff: the
    // row exists to hold them and its own body is blank. Rendering those puts
    // "someone commented" cards with nothing in them through the conversation.
    const timeline = buildForgeTimeline({
      body: "b",
      createdAt: 1,
      comments: [],
      reviews: [review(10, "COMMENTED", "   "), review(20, "COMMENTED", "a real note")],
    });
    expect(timeline.filter((entry) => entry.kind === "review").map((entry) => entry.body)).toEqual(["a real note"]);
  });

  test("an EMPTY APPROVED review is KEPT — who approved and when is the whole content", () => {
    const timeline = buildForgeTimeline({ body: "b", createdAt: 1, comments: [], reviews: [review(10, "APPROVED", "")] });
    expect(timeline.filter((entry) => entry.kind === "review")).toHaveLength(1);
    expect(timeline.at(-1)).toMatchObject({ state: "APPROVED", author: "grace" });
  });

  test("a hidden comment carries its reason so the card can collapse it", () => {
    const timeline = buildForgeTimeline({
      body: "b",
      createdAt: 1,
      comments: [comment(10, "spam", { minimized: true, minimizedReason: "SPAM", authorAssociation: "NONE" })],
    });
    // `NONE` is not worth a badge, so it does not become an association.
    expect(timeline.at(-1)).toMatchObject({ minimized: true, minimizedReason: "SPAM" });
    expect(timeline.at(-1)!.association).toBeUndefined();
  });

  test("an issue with nothing on it is one entry, not zero", () => {
    // The body IS an entry, so an empty issue still renders one card rather than a
    // blank surface.
    expect(buildForgeTimeline({ body: "", createdAt: 5, comments: [] })).toHaveLength(1);
  });

  test("every entry id is distinct, including two reviews in the same second", () => {
    // Two reviews submitted in the same second by a bot batch is real, and duplicate
    // React keys drop one of them silently.
    const timeline = buildForgeTimeline({
      body: "b",
      createdAt: 1,
      comments: [],
      reviews: [review(10, "APPROVED", "one"), review(10, "APPROVED", "two")],
    });
    expect(new Set(timeline.map((entry) => entry.id)).size).toBe(timeline.length);
  });
});

describe("the sentences", () => {
  test("every way a read can be unavailable has one, and every refusal too", () => {
    // A missing key here is a surface that renders `undefined` at the moment it
    // most needs to explain itself.
    for (const reason of ["not_installed", "not_authenticated", "no_repository", "not_found", "failed"] as const) {
      expect(UNAVAILABLE[reason].title.length).toBeGreaterThan(0);
    }
    for (const refusal of ["not_open", "conflicted", "blocked", "head_moved", "method_not_allowed", "not_permitted", "failed"] as const) {
      expect(MERGE_REFUSAL[refusal].length).toBeGreaterThan(0);
    }
  });

  test("an unfamiliar review state is shown as GitHub sent it, not dropped", () => {
    expect(reviewLabel("CHANGES_REQUESTED")).toBe("requested changes");
    expect(reviewLabel("SOMETHING_NEW")).toBe("something new");
  });
});
