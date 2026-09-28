import { describe, expect, test } from "bun:test";
import {
  activeFilterCount,
  authorMonogram,
  avatarSrc,
  AVATAR_PIXELS,
  buildForgeTimeline,
  checkHeadline,
  filterChips,
  checkSummary,
  issueStatus,
  mergeReadiness,
  MERGE_REFUSAL,
  PULL_CREATE_REFUSAL,
  PUSH_REFUSAL,
  offersMerge,
  pullStatus,
  applyReaction,
  reactionPills,
  REACTIONS,
  REACTION_REFUSAL,
  toggleReaction,
  hunkTail,
  threadAnchor,
  threadsByFile,
  applyThreadReply,
  applyThreadResolve,
  PENDING_REPLY_URL,
  THREAD_REFUSAL,
  reviewLabel,
  STATUS_LABEL,
  STATUS_TONE,
  UNAVAILABLE,
} from "./github-forge";

const check = (conclusion?: string, status = "COMPLETED") => ({ name: "c", status, ...(conclusion ? { conclusion } : {}) });

describe("checkSummary", () => {
  test("a check with no conclusion is RUNNING, not passing", () => {
    const summary = checkSummary([check(undefined, "IN_PROGRESS"), check(undefined, "QUEUED"), check("SUCCESS")]);
    expect(summary).toMatchObject({ running: 2, passed: 1, failed: 0 });
  });

  test("skipped is not a pass, and cancelled is not a failure", () => {
    // A fully skipped matrix is not "passed", and a cancelled run is not a failure.
    const summary = checkSummary([check("SKIPPED"), check("SKIPPED"), check("CANCELLED"), check("NEUTRAL")]);
    expect(summary).toEqual({ total: 4, passed: 0, failed: 0, running: 0, skipped: 2, neutral: 2 });
  });

  test("the four conclusions that are genuinely red", () => {
    const summary = checkSummary([check("FAILURE"), check("TIMED_OUT"), check("ACTION_REQUIRED"), check("STARTUP_FAILURE")]);
    expect(summary.failed).toBe(4);
  });

  test("no checks at all is not the same as everything passing", () => {
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

  test("clean and open merges, and still says so", () => {
    const readiness = mergeReadiness(pull());
    expect(readiness.canMerge).toBe(true);
    expect(readiness.note).toContain("main");
  });

  test("a mergeStateStatus this cockpit has never met still says something", () => {
    const readiness = mergeReadiness(pull({ mergeStateStatus: "SOMETHING_NEW" }));
    expect(readiness.canMerge).toBe(true);
    expect(readiness.note).toBeTruthy();
  });

  test("mergeability GitHub has not computed is ALLOWED, not refused", () => {
    // GitHub computes mergeability lazily; pressing merge is what makes it work it out.
    expect(mergeReadiness(pull({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }))).toMatchObject({ canMerge: true, caution: true });
  });

  test("failing checks that nothing requires are ALLOWED, and named", () => {
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
    expect(mergeReadiness(pull({ state: "MERGED" }))).toEqual({ canMerge: false });
    expect(mergeReadiness(pull({ state: "CLOSED" }))).toEqual({ canMerge: false });
  });
});

describe("issueStatus", () => {
  test("SIX outcomes, not two — done and abandoned are different answers", () => {
    expect(issueStatus({ state: "OPEN" })).toBe("open");
    expect(issueStatus({ state: "CLOSED", stateReason: "COMPLETED" })).toBe("completed");
    expect(issueStatus({ state: "CLOSED", stateReason: "NOT_PLANNED" })).toBe("abandoned");
    expect(issueStatus({ state: "CLOSED", stateReason: "DUPLICATE" })).toBe("abandoned");
    expect(issueStatus({ state: "CLOSED" })).toBe("closed");
  });

  test("green is reserved for finishing", () => {
    expect(STATUS_TONE[issueStatus({ state: "CLOSED", stateReason: "COMPLETED" })]).toBe("done");
    expect(STATUS_TONE[issueStatus({ state: "CLOSED", stateReason: "NOT_PLANNED" })]).toBe("none");
    expect(STATUS_TONE[issueStatus({ state: "OPEN" })]).toBe("active");
    for (const status of ["open", "draft", "merged", "closed", "completed", "abandoned"] as const) {
      expect(STATUS_TONE[status]).not.toBe("danger");
      expect(STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });
});

describe("pullStatus", () => {
  test("merged wins over every other reading", () => {
    // GitHub reports merged PRs as CLOSED or MERGED; `mergedAt` is the fact underneath.
    expect(pullStatus({ state: "MERGED", isDraft: false })).toBe("merged");
    expect(pullStatus({ state: "CLOSED", isDraft: false, mergedAt: 1 })).toBe("merged");
    expect(pullStatus({ state: "CLOSED", isDraft: false })).toBe("closed");
    expect(pullStatus({ state: "OPEN", isDraft: false })).toBe("open");
  });

  test("a CLOSED draft is closed, not a draft", () => {
    expect(pullStatus({ state: "CLOSED", isDraft: true })).toBe("closed");
    expect(pullStatus({ state: "OPEN", isDraft: true })).toBe("draft");
  });
});

describe("offersMerge", () => {
  test("an open pull request has a merge control behind its row", () => {
    expect(offersMerge({ state: "OPEN", isDraft: false })).toBe(true);
  });

  test("nothing that MergeFooter would refuse or omit gets the sign", () => {
    expect(offersMerge({ state: "OPEN", isDraft: true })).toBe(false); // MergeFooter disables a draft
    expect(offersMerge({ state: "MERGED", isDraft: false })).toBe(false); // …and renders nothing at all
    expect(offersMerge({ state: "CLOSED", isDraft: false })).toBe(false);
    expect(offersMerge({ state: "CLOSED", isDraft: false, mergedAt: 1 })).toBe(false);
  });

  test("it is not a mergeability claim, and could not be one", () => {
    // A list row has no `mergeable`/`mergeStateStatus`, so both PRs below look the same here.
    const row = { state: "OPEN", isDraft: false };
    expect(offersMerge(row)).toBe(true);
    expect(mergeReadiness({ ...row, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }).canMerge).toBe(true);
    expect(mergeReadiness({ ...row, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }).canMerge).toBe(false);
  });
});

describe("filterChips", () => {
  test("every narrowing beyond the state gets a removable chip", () => {
    // A hidden filter that returns nothing looks like an empty repository.
    const chips = filterChips({ milestone: "v2", assignee: "ada", author: "grace", labels: ["bug", "web"] });
    expect(chips.map((chip) => chip.label)).toEqual(["v2", "@ada", "by grace", "bug", "web"]);
    expect(activeFilterCount({ milestone: "v2", assignee: "ada", author: "grace", labels: ["bug", "web"] })).toBe(5);
  });

  test("THE STATE IS NOT A CHIP", () => {
    expect(filterChips({ labels: [] })).toEqual([]);
    expect(activeFilterCount({ labels: [] })).toBe(0);
  });

  test("a label chip carries its value, because clearing one must not clear the others", () => {
    const chips = filterChips({ labels: ["bug", "web"] });
    expect(chips.map((chip) => [chip.clear, chip.value])).toEqual([
      ["label", "bug"],
      ["label", "web"],
    ]);
  });

  test("two labels with the same name as a milestone stay distinct", () => {
    // Keys are React keys; a collision drops a chip silently.
    const chips = filterChips({ milestone: "bug", labels: ["bug"] });
    expect(new Set(chips.map((chip) => chip.key)).size).toBe(2);
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
    const timeline = buildForgeTimeline({ body: "opened", createdAt: 100, comments: [comment(100, "bot"), comment(50, "impossible")] });
    expect(timeline[0]).toMatchObject({ kind: "body", body: "opened" });
  });

  test("an EMPTY `COMMENTED` review is dropped — it is not an event", () => {
    // GitHub creates an empty one to hold inline diff comments.
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
    expect(timeline.at(-1)).toMatchObject({ minimized: true, minimizedReason: "SPAM" });
    expect(timeline.at(-1)!.association).toBeUndefined();
  });

  test("an issue with nothing on it is one entry, not zero", () => {
    expect(buildForgeTimeline({ body: "", createdAt: 5, comments: [] })).toHaveLength(1);
  });

  test("every entry id is distinct, including two reviews in the same second", () => {
    // Duplicate React keys would drop one silently.
    const timeline = buildForgeTimeline({
      body: "b",
      createdAt: 1,
      comments: [],
      reviews: [review(10, "APPROVED", "one"), review(10, "APPROVED", "two")],
    });
    expect(new Set(timeline.map((entry) => entry.id)).size).toBe(timeline.length);
  });

  test("a face travels with every kind of entry, and an absent one stays absent (#790)", () => {
    const timeline = buildForgeTimeline({
      body: "b",
      author: "ada",
      authorAvatar: "https://github.com/ada.png",
      createdAt: 1,
      comments: [comment(10, "c", { author: "grace", authorAvatar: "https://github.com/grace.png" }), comment(20, "d", { author: "app/renovate" })],
      reviews: [{ state: "APPROVED", body: "ok", submittedAt: 30, author: "alan", authorAvatar: "https://github.com/alan.png" }],
    });
    expect(timeline.map((entry) => [entry.kind, entry.avatar])).toEqual([
      ["body", "https://github.com/ada.png"],
      ["comment", "https://github.com/grace.png"],
      // A bot has no avatar; the card draws a monogram instead.
      ["comment", undefined],
      ["review", "https://github.com/alan.png"],
    ]);
  });
});

describe("an author's avatar", () => {
  test("is asked for at ONE size, so a thread of one author is ONE fetch", () => {
    // `?size=` is part of the browser's cache key, so one size means one fetch per author.
    expect(avatarSrc("https://github.com/ada.png")).toBe(`https://github.com/ada.png?size=${AVATAR_PIXELS}`);
    expect(AVATAR_PIXELS).toBeGreaterThan(16);
  });

  test("falls back to a letter, never to a blank circle", () => {
    expect(authorMonogram("Facundo-Barbera")).toBe("F");
    // Bots arrive as `app/<slug>`.
    expect(authorMonogram("app/renovate")).toBe("R");
    // `gh` sends no author for a deleted account.
    expect(authorMonogram(undefined)).toBe("?");
    expect(authorMonogram("  ")).toBe("?");
  });
});

describe("the sentences", () => {
  test("every way a read can be unavailable has one, and every refusal too", () => {
    for (const reason of ["not_installed", "not_authenticated", "no_repository", "not_github", "not_found", "failed"] as const) {
      expect(UNAVAILABLE[reason].title.length).toBeGreaterThan(0);
    }
    for (const refusal of ["not_open", "conflicted", "blocked", "head_moved", "method_not_allowed", "not_permitted", "failed"] as const) {
      expect(MERGE_REFUSAL[refusal].length).toBeGreaterThan(0);
    }
    for (const refusal of [
      "not_repository",
      "local_checkout",
      "no_remote",
      "not_session_branch",
      "nothing_to_push",
      "not_permitted",
      "rejected",
      "auth",
      "timeout",
      "failed",
    ] as const) {
      expect(PUSH_REFUSAL[refusal].length).toBeGreaterThan(0);
    }
    for (const refusal of ["not_pushed", "exists", "nothing_to_compare", "invalid_title", "not_permitted", "failed"] as const) {
      expect(PULL_CREATE_REFUSAL[refusal].length).toBeGreaterThan(0);
    }
  });

  test("A REPOSITORY THAT IS NOT ON GITHUB IS NOT A MISSING ONE, and the two now say so — #670", () => {
    expect(UNAVAILABLE.not_github.title).not.toBe(UNAVAILABLE.no_repository.title);
    expect(UNAVAILABLE.not_github.detail).toContain("not a GitHub host");
    expect(UNAVAILABLE.not_github.detail).toContain("pushing");
  });

  test("NO PUSH SENTENCE OFFERS A FORCE, least of all the one where it is tempting", () => {
    // The engine cannot force-push (`scripts/source-invariants.mjs` enforces it).
    for (const sentence of Object.values(PUSH_REFUSAL)) {
      expect(sentence.toLowerCase()).not.toContain("--force");
    }
    expect(PUSH_REFUSAL.rejected).toContain("Pull or rebase");
    expect(PUSH_REFUSAL.rejected).toContain("will not force");
  });

  test("the refusals that are ordinary states do not read as failures", () => {
    expect(PUSH_REFUSAL.nothing_to_push).toContain("Nothing to push");
    expect(PUSH_REFUSAL.local_checkout).toContain("shares with your editor");
    expect(PULL_CREATE_REFUSAL.exists).toContain("already open");
  });

  test("an unfamiliar review state is shown as GitHub sent it, not dropped", () => {
    expect(reviewLabel("CHANGES_REQUESTED")).toBe("requested changes");
    expect(reviewLabel("SOMETHING_NEW")).toBe("something new");
  });
});

describe("a comment's session", () => {
  const withSession = (at: number, sessionId?: string) => ({
    body: `c${at}`,
    createdAt: at,
    minimized: false,
    url: `https://gh/c${at}`,
    ...(sessionId ? { attribution: { sessionId } } : {}),
  });

  test("an attributed comment carries its session, an unattributed one carries none", () => {
    const timeline = buildForgeTimeline({
      body: "opened",
      createdAt: 100,
      comments: [withSession(200, "session_abc"), withSession(300)],
    });
    expect(timeline.find((entry) => entry.at === 200)?.sessionId).toBe("session_abc");
    expect(timeline.find((entry) => entry.at === 300)?.sessionId).toBeUndefined();
  });
});

describe("reactions (#842)", () => {
  test("the body card carries the thing's own reactions and each comment its own", () => {
    const timeline = buildForgeTimeline({
      body: "b",
      createdAt: 1,
      reactions: [{ content: "HEART", count: 2, viewerHasReacted: false }],
      comments: [{ body: "c", createdAt: 2, minimized: false, url: "u1", reactions: [{ content: "ROCKET", count: 1, viewerHasReacted: true }] }],
    });
    expect(timeline[0]!.reactions).toEqual([{ content: "HEART", count: 2, viewerHasReacted: false }]);
    expect(timeline[1]!.reactions).toEqual([{ content: "ROCKET", count: 1, viewerHasReacted: true }]);
  });

  test("absent stays absent — a failed read must not become \"nobody reacted\"", () => {
    const timeline = buildForgeTimeline({ body: "b", createdAt: 1, comments: [{ body: "c", createdAt: 2, minimized: false, url: "u1" }] });
    expect("reactions" in timeline[0]!).toBe(false);
    expect("reactions" in timeline[1]!).toBe(false);
  });

  test("pills come out in GitHub's order, with glyphs, whatever order they arrived in", () => {
    const pills = reactionPills([
      { content: "EYES", count: 1, viewerHasReacted: false },
      { content: "THUMBS_UP", count: 3, viewerHasReacted: true },
    ]);
    expect(pills.map((pill) => [pill.glyph, pill.count, pill.viewerHasReacted])).toEqual([
      ["👍", 3, true],
      ["👀", 1, false],
    ]);
  });

  test("a content this cockpit does not know is dropped, not drawn as a bare word", () => {
    expect(reactionPills([{ content: "SMILE", count: 1, viewerHasReacted: false }])).toEqual([]);
  });

  test("all eight of GitHub's reactions are known, once each", () => {
    expect(new Set(REACTIONS.map((reaction) => reaction.content)).size).toBe(8);
  });
});

describe("toggleReaction — the optimistic guess (#842)", () => {
  const HEART = (count: number, viewerHasReacted: boolean) => ({ content: "HEART", count, viewerHasReacted });

  test("adding to somebody else's pill counts you in", () => {
    expect(toggleReaction([HEART(2, false)], "HEART", true)).toEqual([HEART(3, true)]);
  });

  test("a reaction nobody used yet appears as yours, at one", () => {
    expect(toggleReaction([], "ROCKET", true)).toEqual([{ content: "ROCKET", count: 1, viewerHasReacted: true }]);
  });

  test("taking back the only one removes the pill rather than leaving a zero", () => {
    expect(toggleReaction([HEART(1, true)], "HEART", false)).toEqual([]);
  });

  test("taking back yours from a crowd leaves the crowd", () => {
    expect(toggleReaction([HEART(4, true)], "HEART", false)).toEqual([HEART(3, false)]);
  });

  test("asking for what is already true changes nothing — a double click cannot count you twice", () => {
    expect(toggleReaction([HEART(2, true)], "HEART", true)).toEqual([HEART(2, true)]);
  });
});

describe("applyReaction — optimistic, then GitHub's answer or a rollback (#842)", () => {
  const before = [{ content: "HEART", count: 1, viewerHasReacted: false }];

  test("draws the guess at once, then GitHub's count", async () => {
    const drawn: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pending = applyReaction({
      current: before,
      content: "HEART",
      react: true,
      send: async () => {
        await gate;
        return { reacted: true, reactions: [{ content: "HEART", count: 7, viewerHasReacted: true }] };
      },
      draw: (reactions) => drawn.push(reactions),
    });
    expect(drawn).toEqual([[{ content: "HEART", count: 2, viewerHasReacted: true }]]);
    release();
    expect(await pending).toBeUndefined();
    expect(drawn.at(-1)).toEqual([{ content: "HEART", count: 7, viewerHasReacted: true }]);
  });

  test("A REFUSAL ROLLS BACK to exactly what was there, and says why", async () => {
    const drawn: unknown[] = [];
    const said = await applyReaction({
      current: before,
      content: "HEART",
      react: true,
      send: async () => ({ reacted: false, refusal: "scope" }),
      draw: (reactions) => drawn.push(reactions),
    });
    expect(drawn.at(-1)).toBe(before);
    expect(said).toBe(REACTION_REFUSAL.scope);
    expect(said).toContain("gh auth refresh");
  });

  test("an engine that does not answer rolls back too", async () => {
    const drawn: unknown[] = [];
    const said = await applyReaction({
      current: before,
      content: "HEART",
      react: true,
      send: async () => {
        throw new Error("connection refused");
      },
      draw: (reactions) => drawn.push(reactions),
    });
    expect(drawn.at(-1)).toBe(before);
    expect(said).toBe("connection refused");
  });
});

const reviewThread = (over: Record<string, unknown> = {}) =>
  ({
    id: "PRRT_1",
    path: "src/a.ts",
    line: 42,
    diffSide: "RIGHT",
    subjectType: "LINE",
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    diffHunk: "@@ -1,3 +1,3 @@",
    comments: [],
    moreComments: 0,
    ...over,
  }) as Parameters<typeof threadAnchor>[0];

describe("threadAnchor — where a thread sits", () => {
  test("one line on the head", () => {
    expect(threadAnchor(reviewThread())).toMatchObject({ path: "src/a.ts", from: 42, to: 42, side: "head", outdated: false, label: "L42" });
  });

  test("a multi-line thread spans its start to its line", () => {
    expect(threadAnchor(reviewThread({ startLine: 40 })).label).toBe("L40–42");
  });

  test("AN OUTDATED THREAD FALLS BACK TO WHERE IT WAS WRITTEN, and says it is outdated", () => {
    const anchor = threadAnchor(reviewThread({ line: undefined, originalLine: 17, originalStartLine: 15, isOutdated: true }));
    expect(anchor).toMatchObject({ from: 15, to: 17, outdated: true, label: "L15–17" });
  });

  test("a line with no current place is outdated even when GitHub did not flag it", () => {
    expect(threadAnchor(reviewThread({ line: undefined, originalLine: 3 })).outdated).toBe(true);
  });

  test("a comment on the base side is marked as such", () => {
    expect(threadAnchor(reviewThread({ diffSide: "LEFT" }))).toMatchObject({ side: "base", label: "L42 (base)" });
  });

  test("a whole-file comment has no line", () => {
    expect(threadAnchor(reviewThread({ subjectType: "FILE", line: undefined }))).toMatchObject({ label: "file" });
  });
});

describe("hunkTail — the lines a thread is about", () => {
  const hunk = "@@ -10,6 +10,7 @@ fn()\n a\n b\n c\n-d\n+D\n+E\n f";

  test("drops the header and keeps the commented line plus three above", () => {
    expect(hunkTail(hunk)).toEqual([
      { kind: "del", text: "d" },
      { kind: "add", text: "D" },
      { kind: "add", text: "E" },
      { kind: "ctx", text: "f" },
    ]);
  });

  test("a multi-line thread keeps its whole span", () => {
    expect(hunkTail(hunk, 3)).toHaveLength(6);
  });

  test("a hunk shorter than the window is kept whole, without its header", () => {
    expect(hunkTail("@@ -1 +1 @@\n-x\n+y\n").map((line) => line.kind)).toEqual(["del", "add"]);
  });
});

describe("threadsByFile", () => {
  test("files in path order, threads top to bottom inside each", () => {
    const grouped = threadsByFile([
      reviewThread({ id: "b2", path: "b.ts", line: 9 }),
      reviewThread({ id: "a1", path: "a.ts", line: 30 }),
      reviewThread({ id: "b1", path: "b.ts", line: 2 }),
      reviewThread({ id: "a0", path: "a.ts", subjectType: "FILE", line: undefined }),
    ]);
    expect(grouped.map((file) => [file.path, file.threads.map((thread) => thread.id)])).toEqual([
      ["a.ts", ["a0", "a1"]],
      ["b.ts", ["b1", "b2"]],
    ]);
  });
});

describe("applyThreadResolve — fold now, GitHub's state or a rollback after (#842)", () => {
  const open = reviewThread();

  test("folds at once, then takes GitHub's state and who may flip it back", async () => {
    const drawn: { isResolved: boolean; resolvedBy?: string; viewerCanUnresolve: boolean }[] = [];
    const said = await applyThreadResolve({
      current: open,
      resolved: true,
      send: async () => ({ changed: true, isResolved: true, resolvedBy: "ada", viewerCanResolve: false, viewerCanUnresolve: true }),
      draw: (thread) => drawn.push(thread),
    });
    expect(said).toBeUndefined();
    expect(drawn[0]!.isResolved).toBe(true);
    expect(drawn.at(-1)).toMatchObject({ isResolved: true, resolvedBy: "ada", viewerCanUnresolve: true });
  });

  test("A REFUSAL PUTS THE THREAD BACK exactly, and says why", async () => {
    const drawn: unknown[] = [];
    const said = await applyThreadResolve({
      current: open,
      resolved: true,
      send: async () => ({ changed: false, refusal: "scope" }),
      draw: (thread) => drawn.push(thread),
    });
    expect(drawn.at(-1)).toBe(open);
    expect(said).toBe(THREAD_REFUSAL.scope);
  });
});

describe("applyThreadReply — a pending reply, then GitHub's comment or a rollback (#842)", () => {
  const open = reviewThread({ comments: [{ body: "Off by one?", createdAt: 1, url: "u1", reactions: [] }] });
  const stored = { author: "ada", body: "Fixed.", createdAt: 5, url: "https://github.com/o/r/pull/7#discussion_r2", reactions: [], subjectId: "PRRC_2" };

  test("the reply shows at once as pending, then becomes the comment GitHub stored", async () => {
    const drawn: { comments: { url: string; body: string }[] }[] = [];
    const said = await applyThreadReply({
      current: open,
      body: " Fixed. ",
      now: 99,
      send: async () => ({ replied: true, comment: stored }),
      draw: (thread) => drawn.push(thread),
    });
    expect(said).toBeUndefined();
    expect(drawn[0]!.comments.at(-1)).toMatchObject({ body: "Fixed.", url: `${PENDING_REPLY_URL}99` });
    expect(drawn.at(-1)!.comments.map((comment) => comment.url)).toEqual(["u1", stored.url]);
  });

  test("A REFUSED REPLY IS TAKEN BACK OFF THE THREAD, and says why", async () => {
    const drawn: unknown[] = [];
    const said = await applyThreadReply({
      current: open,
      body: "Fixed.",
      now: 99,
      send: async () => ({ replied: false, refusal: "not_permitted" }),
      draw: (thread) => drawn.push(thread),
    });
    expect(drawn.at(-1)).toBe(open);
    expect(said).toBe(THREAD_REFUSAL.not_permitted);
  });

  test("an engine that does not answer rolls the reply back too", async () => {
    const drawn: unknown[] = [];
    const said = await applyThreadReply({
      current: open,
      body: "Fixed.",
      now: 99,
      send: async () => {
        throw new Error("connection refused");
      },
      draw: (thread) => drawn.push(thread),
    });
    expect(drawn.at(-1)).toBe(open);
    expect(said).toBe("connection refused");
  });
});
