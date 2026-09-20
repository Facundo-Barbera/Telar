/**
 * The `gh` seam.
 *
 * Every one of these is about a FAILURE MODE rather than about the happy path,
 * because the happy path is `JSON.parse` and the failures are where a surface
 * either tells a reader what to do or wastes their afternoon.
 */
import { describe, expect, test } from "bun:test";
import { MAX_COMMENT_BODY } from "@telar/engine-client";
import {
  classifyCommentFailure,
  classifyDetailFailure,
  classifyGhFailure,
  classifyMergeFailure,
  classifyProjectFailure,
  commentOn,
  listArgv,
  parseCommentUrl,
  MAX_CHECK_LOG_LINES,
  MAX_FACET_VALUES,
  MAX_THREAD_COMMENTS,
  mergePull,
  parseCheckLog,
  parseChecks,
  parseComments,
  parseIssueDetail,
  parseIssues,
  parseJobId,
  parseMergeMethods,
  parseProjectItems,
  parsePullDetail,
  parsePulls,
  parseRepoFromUrl,
  parseReviews,
  parseThreadAuthors,
  readCheckLog,
  readForgeFacets,
  readGitHub,
  readIssue,
  readPull,
  type GhResult,
  type GhRunner,
} from "../src/github";

const ok = (stdout: string): GhResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): GhResult => ({ status, stdout: "", stderr });

/** Keyed by the first argv word, which is all these three calls differ by. */
function runner(replies: Record<string, GhResult>): GhRunner {
  return async (_cwd, args) => replies[args[0] ?? ""] ?? failed("unexpected call");
}

/** Keyed by the first TWO words, so `pr view` and `pr merge` can answer
 *  differently — which is the whole shape of a merge. */
function verbRunner(replies: Record<string, GhResult | GhResult[]>, seen?: string[][]): GhRunner {
  const drawn = new Map<string, number>();
  return async (_cwd, args) => {
    seen?.push(args);
    const key = args.slice(0, 2).join(" ");
    const reply = replies[key];
    if (!reply) return failed(`unexpected call: ${key}`);
    if (!Array.isArray(reply)) return reply;
    // An array answers successive calls in order — a merge reads the pull request
    // BEFORE and AFTER, and the two are different.
    const at = drawn.get(key) ?? 0;
    drawn.set(key, at + 1);
    return reply[Math.min(at, reply.length - 1)]!;
  };
}

describe("classifyGhFailure", () => {
  test("tells the four kinds of nothing apart", () => {
    // They need four different responses from a human, and the third is usually
    // "nothing, that is fine". One grey empty list would earn none of them.
    expect(classifyGhFailure(failed("", 127)).unavailable).toBe("not_installed");
    expect(classifyGhFailure(failed("gh: To get started with GitHub CLI, please run: gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyGhFailure(failed("failed to run git: fatal: not a git repository")).unavailable).toBe("no_repository");
  });

  test("an unrecognised failure keeps gh's own words rather than guessing", () => {
    // The match is on phrasing and phrasing changes upstream; degrading to
    // "here is what gh said" beats degrading to a wrong diagnosis.
    const result = classifyGhFailure(failed("HTTP 403: API rate limit exceeded"));
    expect(result.unavailable).toBe("failed");
    expect(result.message).toBe("HTTP 403: API rate limit exceeded");
  });
});

describe("parseIssues", () => {
  test("a row carries everything a list can show without a second read", () => {
    // The whole shape, pinned. Dates converted once at the seam rather than by
    // every client that renders one; assignees flattened to logins because a bot
    // has a login and no name; the milestone reduced to its title, which is the
    // only part a 320px row has space for.
    const [issue] = parseIssues(
      JSON.stringify([
        {
          number: 82,
          title: "Navigation freezes",
          state: "OPEN",
          author: { login: "ada", name: "Ada L" },
          labels: [{ name: "bug", color: "d73a4a" }, { name: "" }],
          assignees: [{ login: "grace" }, { login: "" }],
          milestone: { title: "v2", description: "…" },
          updatedAt: "2026-08-08T18:54:57Z",
          url: "https://github.com/o/r/issues/82",
        },
      ]),
    );
    expect(issue).toEqual({
      number: 82,
      title: "Navigation freezes",
      state: "OPEN",
      author: "ada",
      // DERIVED FROM THE LOGIN, because `gh` sends no avatar field at ALL — the
      // author object above is everything it sends, and it has no URL in it (#790).
      authorAvatar: "https://github.com/ada.png",
      // A label with no name is dropped rather than rendered as an empty chip, and
      // so is an assignee with no login.
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["grace"],
      milestone: "v2",
      // EMPTY UNTIL THE BOARD CALL FILLS IT IN. `projectItems` needs a scope this
      // query does not have, so it is read separately — see the board tests below.
      projects: [],
      // Nothing is linked to close this one, and that IS the answer — unlike
      // `projects`, this field rides the row read, so a row that arrived has it.
      linkedPulls: [],
      updatedAt: Date.parse("2026-08-08T18:54:57Z"),
      url: "https://github.com/o/r/issues/82",
    });
  });

  test("a closed row says WHY it closed", () => {
    // On the row and not just the detail: a list that includes closed issues is a
    // list where "was this done?" is the question every row raises.
    const [issue] = parseIssues(
      JSON.stringify([{ number: 1, title: "t", state: "CLOSED", stateReason: "NOT_PLANNED", url: "u", updatedAt: "2026-01-01T00:00:00Z" }]),
    );
    expect(issue).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a row without a number is not a row", () => {
    expect(parseIssues(JSON.stringify([{ title: "orphan" }]))).toEqual([]);
  });
});

const DAY = "2026-08-01T00:00:00Z";

/**
 * THE AUTHOR'S FACE — issue #790.
 *
 * THE PREMISE HAD TO BE CORRECTED AND THAT IS WHAT THESE PIN. #790 reads as "these
 * fields are not in `github.ts`'s `gh` field sets"; for the issue↔PR link that is
 * exactly right, and for the avatar there is NO FIELD TO ADD. Measured against this
 * repository: `--json author` answers `{id, is_bot, login, name}` and `--json
 * comments` answers `author: {login}`. So these tests are about a DERIVATION, and the
 * one below about the field sets is about `author` — because if `author` ever left a
 * field set, both the login and the face would go with it and no avatar test would
 * notice.
 */
describe("the author's face", () => {
  const rowWith = (author: unknown) =>
    parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u", updatedAt: DAY, author }]))[0]!;

  test("comes from the login, because gh sends no avatar field to read", () => {
    expect(rowWith({ login: "ada", name: "Ada L", id: "MDQ6VXNlcjE=", is_bot: false })).toMatchObject({
      author: "ada",
      // GitHub's own redirect: measured, `github.com/<login>.png?size=64` answers
      // 302 to `avatars.githubusercontent.com/u/…?s=64`. No size here — that is the
      // renderer's, so one shared size keeps a thread to one fetch.
      authorAvatar: "https://github.com/ada.png",
    });
    expect(rowWith({ login: "ada" }).authorAvatar).not.toContain("size=");
  });

  test("A BOT GETS NO FACE, because the derived URL is WRONG for one rather than slow", () => {
    /**
     * Measured, in both the shapes `gh` uses. A list or detail author carries the
     * flag and the prefix — `{is_bot: true, login: "app/renovate"}`, against
     * renovatebot/renovate — and `github.com/app/renovate.png` is not a user page.
     * Either signal alone is enough, so an author object that dropped one still
     * lands here.
     */
    expect(rowWith({ login: "app/renovate", is_bot: true }).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "app/renovate" }).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "renovate", is_bot: true }).authorAvatar).toBeUndefined();
    // …and the login still travels. A bot's comment must still say who wrote it.
    expect(rowWith({ login: "app/renovate", is_bot: true }).author).toBe("app/renovate");
  });

  test("no author at all is no face, not a URL with a hole in it", () => {
    // `gh` sends `author: null` for a deleted account — a URL built from that would
    // be `github.com/.png`, which is a 404 this engine would have invented.
    expect(rowWith(null).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "" }).authorAvatar).toBeUndefined();
  });

  test("a login is escaped into the URL rather than pasted into it", () => {
    // No GitHub login contains a slash or a space, so nothing here exercises it in
    // the wild — which is exactly why it is pinned: the one shape that DOES reach
    // this is a bot's `app/renovate`, and it is excluded one line above by a rule
    // somebody could remove.
    expect(rowWith({ login: "a b/c" }).authorAvatar).toBe("https://github.com/a%20b%2Fc.png");
  });

  test("a comment and a review carry it the same way a row does", () => {
    // One helper for all three, so a thread cannot show a face on the opening post
    // and none on the replies.
    const thread = parseComments([{ url: "c1", body: "b", createdAt: DAY, author: { login: "grace" } }]);
    expect(thread.comments[0]).toMatchObject({ author: "grace", authorAvatar: "https://github.com/grace.png" });
    const reviews = parseReviews([{ author: { login: "alan" }, state: "APPROVED", body: "", submittedAt: DAY }]);
    expect(reviews[0]).toMatchObject({ author: "alan", authorAvatar: "https://github.com/alan.png" });
  });

  /**
   * THE FORGE THIS WAS READ OUT OF DECIDES — issue #814, and the half that is
   * invisible on this Mac.
   *
   * `gh` SUPPORTS GITHUB ENTERPRISE SERVER and `defaultGhRunner` forwards
   * `process.env`, so `GH_HOST` works and a corporate checkout reaches this parser
   * unimpeded. Nothing else in the engine gates on github.com — `parseRepoFromUrl`
   * accepts any host and discards it. A corporate login is `jsmith`-shaped, and on
   * public github.com `jsmith` is a stranger: that is the stranger's-face failure
   * at 100% of authors rather than at a bot-slug collision.
   */
  describe("and it is only derived for a github.com forge", () => {
    const GHES = "https://ghe.corp.example/o/r/issues/1";
    const faceFor = (url: string) =>
      parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url, updatedAt: DAY, author: { login: "ada" } }]))[0]!.authorAvatar;

    test("a row from another host gets the login and NO face", () => {
      const row = parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: GHES, updatedAt: DAY, author: { login: "jsmith" } }]))[0]!;
      // The author still travels — the face is the only thing this engine cannot
      // honestly say, and saying nothing is what the monogram is for.
      expect(row.author).toBe("jsmith");
      expect(row.authorAvatar).toBeUndefined();
    });

    test("a comment and a review from another host do too", () => {
      const thread = parseComments([{ url: `${GHES}#issuecomment-1`, body: "b", createdAt: DAY, author: { login: "jsmith" } }]);
      expect(thread.comments[0]!.author).toBe("jsmith");
      expect(thread.comments[0]!.authorAvatar).toBeUndefined();
      // A review carries no url of its own in `gh`'s projection, so it is handed
      // the PULL REQUEST's — otherwise a GHES thread would show faces on the
      // reviews and none on the comments beside them.
      const reviews = parseReviews([{ author: { login: "jsmith" }, state: "APPROVED", body: "", submittedAt: DAY }], GHES);
      expect(reviews[0]!.authorAvatar).toBeUndefined();
    });

    test("github.com itself, and its www alias, still derive", () => {
      expect(faceFor("https://github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
      expect(faceFor("http://github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
      expect(faceFor("https://www.github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
    });

    test("a url that names NO host contradicts nothing, and still derives", () => {
      // Absence is not a second forge. A relative url — and every fixture in this
      // file that writes `url: "u"` — says nothing about which host answered, so it
      // must not be read as "not github.com".
      expect(rowWith({ login: "ada" }).authorAvatar).toBe("https://github.com/ada.png");
      expect(faceFor("/o/r/issues/1")).toBe("https://github.com/ada.png");
    });

    test("a lookalike host is NOT github.com", () => {
      // `github.com.evil.example` and `notgithub.com` both end in the right
      // letters; a `.endsWith` test would hand them the derivation.
      expect(faceFor("https://github.com.evil.example/o/r/issues/1")).toBeUndefined();
      expect(faceFor("https://notgithub.com/o/r/issues/1")).toBeUndefined();
    });
  });

  test("a DETAIL read carries the face too, through the same row parser", () => {
    const issue = parseIssueDetail(JSON.stringify({ number: 7, title: "t", state: "OPEN", url: "u", createdAt: DAY, author: { login: "ada" } }), 1);
    expect(issue.authorAvatar).toBe("https://github.com/ada.png");
    const pull = parsePullDetail(JSON.stringify({ number: 8, title: "t", state: "OPEN", url: "u", createdAt: DAY, author: { login: "ada" } }), 1);
    expect(pull.authorAvatar).toBe("https://github.com/ada.png");
  });
});

/**
 * THE ISSUE↔PR LINK — issue #790, and #49's design calls it "the single most useful
 * thing on a GitHub issue page and we do not have it".
 *
 * MEASURED SHAPES THROUGHOUT. `gh` sends each reference as
 * `{ id, number, url, repository: { id, name, owner: { id, login } } }` — taken off
 * `gh issue view 488 --json closedByPullRequestsReferences` and
 * `gh pr view 786 --json closingIssuesReferences` against this repository, which is
 * the real 488 ↔ 786 pair. No title and no STATE, which is why the field is named
 * for the relation rather than for an outcome.
 */
describe("the issue↔PR link", () => {
  /** One reference, in `gh`'s own shape. */
  const ref = (number: number, owner = "Facundo-Barbera", name = "Telar", kind = "pull") => ({
    id: `PR_${number}`,
    number,
    url: `https://github.com/${owner}/${name}/${kind}/${number}`,
    repository: { id: "R_1", name, owner: { id: "U_1", login: owner } },
  });

  const issueWith = (refs: unknown, url = "https://github.com/Facundo-Barbera/Telar/issues/488") =>
    parseIssues(JSON.stringify([{ number: 488, title: "t", state: "CLOSED", url, updatedAt: DAY, closedByPullRequestsReferences: refs }]))[0]!;
  const pullWith = (refs: unknown, url = "https://github.com/Facundo-Barbera/Telar/pull/786") =>
    parsePulls(JSON.stringify([{ number: 786, title: "t", state: "MERGED", url, updatedAt: DAY, closingIssuesReferences: refs }]))[0]!;

  test("an issue names the pull requests linked to close it", () => {
    expect(issueWith([ref(786)]).linkedPulls).toEqual([{ number: 786, url: "https://github.com/Facundo-Barbera/Telar/pull/786" }]);
  });

  test("and a pull request names the issues it closes — the same relation, other end", () => {
    expect(pullWith([ref(488, "Facundo-Barbera", "Telar", "issues")]).linkedIssues).toEqual([
      { number: 488, url: "https://github.com/Facundo-Barbera/Telar/issues/488" },
    ]);
  });

  test("THE SAME REPOSITORY CARRIES NO `repository`, AND THAT IS THE JUMPABLE SIGNAL", () => {
    // The panel's Pull requests surface can only open THIS repository's numbers, so
    // absence is what a jump is allowed to key on. Present means "link out".
    expect(issueWith([ref(786)]).linkedPulls[0]!.repository).toBeUndefined();
  });

  test("ANOTHER repository keeps its name, so a jump cannot open the wrong #768", () => {
    /**
     * A pull request in another repository closing an issue here is a real GitHub
     * feature, and `gh` sends the repository on every reference — which it would not
     * need to do if it were always the reading one. Without this the panel would
     * open ITS OWN #768, which is a different pull request entirely.
     */
    const linked = issueWith([ref(768, "other", "repo")]).linkedPulls[0]!;
    expect(linked).toEqual({ number: 768, url: "https://github.com/other/repo/pull/768", repository: "other/repo" });
  });

  test("a URL this engine cannot read makes every link a link OUT, not a wrong jump", () => {
    // `parseRepoFromUrl` is the only place a read says which repository it came
    // from. Unparseable — an enterprise host with a different path shape, a row whose
    // url `gh` omitted — and nothing matches, so every reference keeps its repository
    // and the surface links out. The fail-safe direction is the one that cannot land
    // on somebody else's number.
    expect(parseRepoFromUrl("https://github.com/o/r/issues/7")).toBe("o/r");
    expect(parseRepoFromUrl("https://github.com/o/r/pull/7")).toBe("o/r");
    expect(parseRepoFromUrl("")).toBeUndefined();
    expect(parseRepoFromUrl("#488")).toBeUndefined();
    expect(issueWith([ref(786)], "").linkedPulls[0]!.repository).toBe("Facundo-Barbera/Telar");
  });

  test("a reference with no number is dropped, the way a row with no number is", () => {
    expect(issueWith([{ url: "u" }, ref(786)]).linkedPulls.map((link) => link.number)).toEqual([786]);
    // An absent field and a field that is not an array both mean "no links".
    expect(issueWith(undefined).linkedPulls).toEqual([]);
    expect(issueWith(null).linkedPulls).toEqual([]);
    expect(issueWith("nonsense").linkedPulls).toEqual([]);
  });

  test("a reference gh sent without a url still identifies itself by number", () => {
    // Never observed; pinned because the surface renders `url` as a React key and an
    // empty one would collide across two such references.
    expect(issueWith([{ number: 786 }]).linkedPulls).toEqual([{ number: 786, url: "#786" }]);
  });

  test("a DETAIL read carries the link, so it cannot disagree with the row you clicked", () => {
    // A detail is its own `gh` call with its own field list — the one way these two
    // CAN diverge — so both field sets ask for it and both parsers read it.
    const issue = parseIssueDetail(
      JSON.stringify({
        number: 488,
        title: "t",
        state: "CLOSED",
        url: "https://github.com/Facundo-Barbera/Telar/issues/488",
        createdAt: DAY,
        closedByPullRequestsReferences: [ref(786)],
      }),
      1,
    );
    expect(issue.linkedPulls.map((link) => link.number)).toEqual([786]);
    const pull = parsePullDetail(
      JSON.stringify({
        number: 786,
        title: "t",
        state: "MERGED",
        url: "https://github.com/Facundo-Barbera/Telar/pull/786",
        createdAt: DAY,
        closingIssuesReferences: [ref(488, "Facundo-Barbera", "Telar", "issues")],
      }),
      1,
    );
    expect(pull.linkedIssues.map((link) => link.number)).toEqual([488]);
  });
});

describe("parsePulls", () => {
  test("keeps the head branch and GitHub's own review vocabulary", () => {
    // `headRefName` is what lets a session recognise its own pull request;
    // `reviewDecision` is passed through because mapping it is a display
    // decision three clients should not each invent.
    const [pull] = parsePulls(
      JSON.stringify([
        {
          number: 45,
          title: "Fix the rail",
          state: "OPEN",
          isDraft: true,
          headRefName: "telar/session-1",
          reviewDecision: "CHANGES_REQUESTED",
          updatedAt: "2026-08-08T00:00:00Z",
          url: "u",
        },
      ]),
    );
    expect(pull).toMatchObject({ isDraft: true, headRefName: "telar/session-1", reviewDecision: "CHANGES_REQUESTED" });
  });

  test("an OPEN pull request has no merge time — not a merge time of 1970", () => {
    // `epoch` answers 0 for an absent date, and `pullStatus` reads `mergedAt` as
    // proof a pull request landed, so a 0 here would report every open one as merged.
    const [open] = parsePulls(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u", updatedAt: "2026-01-01T00:00:00Z" }]));
    expect(open!.mergedAt).toBeUndefined();
    const [landed] = parsePulls(
      JSON.stringify([{ number: 2, title: "t", state: "MERGED", mergedAt: "2026-08-04T00:00:00Z", url: "u", updatedAt: "2026-08-04T00:00:00Z" }]),
    );
    expect(landed!.mergedAt).toBe(Date.parse("2026-08-04T00:00:00Z"));
  });

  test("a pull request row carries labels, which it never used to", () => {
    // The list row had none — "nothing on a 320px row had space for them" — and
    // then the row grew a second line, which is exactly where they go.
    const [pull] = parsePulls(
      JSON.stringify([
        { number: 3, title: "t", state: "OPEN", url: "u", updatedAt: "2026-01-01T00:00:00Z", labels: [{ name: "deps" }], assignees: [{ login: "ada" }] },
      ]),
    );
    expect(pull).toMatchObject({ labels: [{ name: "deps" }], assignees: ["ada"] });
  });
});

describe("readGitHub", () => {
  test("reads issues, pulls and the repository name in one pass", async () => {
    const snapshot = await readGitHub(
      runner({
        issue: ok(JSON.stringify([{ number: 1, title: "a", state: "OPEN", labels: [], updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        pr: ok(JSON.stringify([{ number: 2, title: "b", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        repo: ok(JSON.stringify({ nameWithOwner: "o/r" })),
      }),
      "/repo",
      () => 1_000,
    );
    expect(snapshot).toMatchObject({ repository: "o/r", readAt: 1_000 });
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.pulls).toHaveLength(1);
    expect(snapshot.unavailable).toBeUndefined();
  });

  test("a repository with issues disabled still reports its pull requests", async () => {
    // They fail independently; reporting the whole repository as unavailable
    // because one endpoint is off would hide work that is right there.
    const snapshot = await readGitHub(
      runner({
        issue: failed("the 'o/r' repository has disabled issues"),
        pr: ok(JSON.stringify([{ number: 2, title: "b", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z", url: "u" }])),
        repo: ok(JSON.stringify({ nameWithOwner: "o/r" })),
      }),
      "/repo",
      () => 1_000,
    );
    expect(snapshot.pulls).toHaveLength(1);
    expect(snapshot.unavailable).toBe("failed");
  });

  test("output this engine cannot read is reported as a failure, not as an empty list", async () => {
    // A version skew must not look like a repository with no issues.
    const snapshot = await readGitHub(runner({ issue: ok("<html>"), pr: ok("[]"), repo: failed("") }), "/repo", () => 0);
    expect(snapshot.unavailable).toBe("failed");
    expect(snapshot.repository).toBeUndefined();
  });
});

describe("which rows a list read asks for", () => {
  /** Every `gh` call this read makes, in the order it made them. */
  async function argvFor(options: Parameters<typeof readGitHub>[3]) {
    const seen: string[][] = [];
    await readGitHub(
      async (_cwd, args) => {
        seen.push(args);
        return args[0] === "repo" ? ok(JSON.stringify({ nameWithOwner: "o/r" })) : ok("[]");
      },
      "/repo",
      () => 1,
      options,
    );
    return seen;
  }

  test("open by default, and the state travels to gh as --state", async () => {
    const seen = await argvFor(undefined);
    expect(seen.find((args) => args[0] === "issue")).toEqual([
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "50",
      "--json",
      expect.any(String),
    ]);
  });

  test("a state PER KIND, because `merged` is not a state an issue can be in", async () => {
    // One shared filter would put a control on the Issues surface that always
    // answers nothing.
    const seen = await argvFor({ issues: { state: "closed", labels: [] }, pulls: { state: "merged", labels: [] } });
    const state = (verb: string) => {
      const args = seen.find((entry) => entry[0] === verb && entry[1] === "list" && entry.includes("--state"))!;
      return args[args.indexOf("--state") + 1];
    };
    expect(state("issue")).toBe("closed");
    expect(state("pr")).toBe("merged");
  });

  test("the snapshot echoes back the WHOLE filter, not just the state", async () => {
    // A surface showing four rows must be able to say why there are four, and one
    // showing none must be able to say whether that is an empty repository or a
    // filter nobody can see. Without the echo it would have to trust that the answer
    // matches what it last sent, which a thirty-second cache makes untrue.
    const snapshot = await readGitHub(
      runner({ issue: ok("[]"), pr: ok("[]"), repo: ok(JSON.stringify({ nameWithOwner: "o/r" })) }),
      "/repo",
      () => 1,
      { issues: { state: "all", milestone: "v2", assignee: "ada", labels: ["bug"] }, pulls: { state: "closed", labels: [] } },
    );
    expect(snapshot.issueFilter).toEqual({ state: "all", milestone: "v2", assignee: "ada", labels: ["bug"] });
    expect(snapshot.pullFilter).toEqual({ state: "closed", labels: [] });
  });
});

/**
 * WHAT THE FOUR FIELD SETS ASK FOR — the half a parser test cannot reach.
 *
 * A PARSER ONLY EVER SEES WHAT WAS ASKED FOR, and a parser test hands it JSON
 * directly. So every test above would go on passing with `author` deleted from
 * `ISSUE_FIELDS`: the rows would arrive authorless, the faces with them, and the
 * suite would be green. These four reads are the only place the `--json` argument is
 * observable, so this is where the field sets get pinned.
 *
 * `author` IS THE AVATAR'S FIELD, which is the whole reason it is asserted here. The
 * face is derived from the login (#790) — there is no avatar field in `gh` to ask
 * for — so `author` leaving a field set is the one edit that silently removes it.
 */
describe("what the field sets ask gh for", () => {
  /** The `--json` value of each read, keyed by the `gh` verb it was asked with. */
  async function fieldsFor(read: (gh: GhRunner) => Promise<unknown>) {
    const asked = new Map<string, string>();
    await read(async (_cwd, args) => {
      const at = args.indexOf("--json");
      if (at !== -1) asked.set(`${args[0]} ${args[1]}`, args[at + 1] ?? "");
      return ok(args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "[]");
    });
    return asked;
  }

  test("every one of the four asks for the author, which is what the face is built from", async () => {
    // `skipProjects` because the board call is ALSO `issue list`, with
    // `number,projectItems` for its fields — and it would be the last write under
    // that key, so this would read the board's field list and not the row's.
    const list = await fieldsFor((gh) => readGitHub(gh, "/repo", () => 1, { skipProjects: true }));
    expect(list.get("issue list")).toContain("author");
    expect(list.get("pr list")).toContain("author");

    const issue = await fieldsFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(issue.get("issue view")).toContain("author");
    const pull = await fieldsFor((gh) => readPull(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(pull.get("pr view")).toContain("author");
  });

  test("and for the issue↔PR link, under the name gh has for it on THAT verb", async () => {
    /**
     * THE TWO NAMES ARE NOT INTERCHANGEABLE AND THAT IS WHAT THIS PINS. An issue
     * takes `closedByPullRequestsReferences`, a pull request `closingIssuesReferences`,
     * and each verb REJECTS the other outright — measured, `gh issue list --json
     * closingIssuesReferences` exits with "Unknown JSON field". Swapped, the list
     * would not render one issue: the whole `--json` query fails, and the surface
     * would report GitHub as broken.
     */
    const list = await fieldsFor((gh) => readGitHub(gh, "/repo", () => 1, { skipProjects: true }));
    expect(list.get("issue list")).toContain("closedByPullRequestsReferences");
    expect(list.get("issue list")).not.toContain("closingIssuesReferences");
    expect(list.get("pr list")).toContain("closingIssuesReferences");
    expect(list.get("pr list")).not.toContain("closedByPullRequestsReferences");

    // AND ON THE DETAIL READS, which are separate `gh` calls with separate field
    // lists — the one way a detail could quietly disagree with its own row.
    const issue = await fieldsFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(issue.get("issue view")).toContain("closedByPullRequestsReferences");
    const pull = await fieldsFor((gh) => readPull(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(pull.get("pr view")).toContain("closingIssuesReferences");
  });

  /**
   * AND WHAT THE FIFTH READ ASKS FOR — issue #814.
   *
   * The same argument as the four above, one layer along: the thread read is a
   * GraphQL document rather than a `--json` list, and a parser test hands the
   * folded map in directly. So every test about a bot's face would go on passing
   * with `avatarUrl` deleted from the query — the nodes would arrive faceless, the
   * derivation would take over, and the suite would be green.
   */
  describe("the thread read", () => {
    /** The `query=` document and the `-F` variables of the GraphQL call, per verb. */
    async function threadReadFor(read: (gh: GhRunner) => Promise<unknown>) {
      let argv: string[] | undefined;
      await read(async (_cwd, args) => {
        if (args[0] === "api" && args[1] === "graphql") argv = args;
        return ok(args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "{}");
      });
      const at = (flag: string, name: string) => {
        const index = argv?.findIndex((arg, position) => argv![position - 1] === flag && arg.startsWith(`${name}=`)) ?? -1;
        return index === -1 ? undefined : argv![index]!.slice(name.length + 1);
      };
      return { argv, query: at("-f", "query") ?? "", variable: (name: string) => at("-F", name) };
    }

    test("BOTH detail paths make it, and it asks for the three facts gh's own projection drops", async () => {
      for (const read of [
        (gh: GhRunner) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }),
        (gh: GhRunner) => readPull(gh, "/repo", 7, () => 1, { skipProjects: true }),
      ]) {
        const thread = await threadReadFor(read);
        expect(thread.argv).toBeDefined();
        // `__typename` is what tells a GitHub App from a person — `gh`'s comment
        // author is `{login}` alone, so without it the engine is back to guessing.
        expect(thread.query).toContain("__typename");
        // The face itself, read rather than derived. Deleting this one field is the
        // edit that silently reinstates #814.
        expect(thread.query).toContain("avatarUrl");
        // Free on this read and on no other: `gh`'s projection has counts and no
        // viewer state.
        expect(thread.query).toContain("reactionGroups");
        expect(thread.query).toContain("viewerHasReacted");
      }
    });

    test("it asks for THIS number, at the engine's own cap, against gh's own repository placeholders", async () => {
      const thread = await threadReadFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
      expect(thread.variable("number")).toBe("7");
      // `last: 100` IS the cap, natively and in the right order. A query asking for
      // a different number than `parseComments` keeps would fold faces onto
      // comments the thread then drops, or drop faces off ones it keeps.
      expect(thread.variable("last")).toBe(String(MAX_THREAD_COMMENTS));
      // `gh` resolves these from the checkout — which is also how this reaches the
      // right host on GitHub Enterprise Server.
      expect(thread.variable("owner")).toBe("{owner}");
      expect(thread.variable("name")).toBe("{repo}");
    });
  });
});

describe("listArgv", () => {
  test("every filter becomes the flag `gh` has for it", () => {
    expect(listArgv("issue", { state: "closed", milestone: "v2", assignee: "@me", author: "ada", labels: ["bug", "web"] }, "number")).toEqual([
      "issue",
      "list",
      "--state",
      "closed",
      "--limit",
      "50",
      "--milestone",
      "v2",
      "--assignee",
      "@me",
      "--author",
      "ada",
      // REPEATED, not comma-joined: a GitHub label may contain a comma, and
      // `--label "a,b"` asks for one label named `a,b` — which somebody can create.
      "--label",
      "bug",
      "--label",
      "web",
      "--json",
      "number",
    ]);
  });

  test("MILESTONE IS DROPPED FOR PULL REQUESTS, because gh has no such flag there", () => {
    // Passing it would make gh fail on a flag this cockpit chose, which reads to the
    // user as "GitHub is broken".
    const argv = listArgv("pr", { state: "open", milestone: "v2", labels: [] } as never, "number");
    expect(argv).not.toContain("--milestone");
    expect(argv).toEqual(["pr", "list", "--state", "open", "--limit", "50", "--json", "number"]);
  });

  test("an unfiltered read sends no filter flags at all", () => {
    expect(listArgv("issue", { state: "open", labels: [] }, "f")).toEqual(["issue", "list", "--state", "open", "--limit", "50", "--json", "f"]);
  });

  test("THE BOARD CALL USES THE SAME FILTER as its rows", async () => {
    /**
     * Boards are folded onto rows BY NUMBER, so a board call filtered differently
     * would attach one issue's boards to another's — silently, and only on a
     * repository where the two result sets differ.
     */
    const seen: string[][] = [];
    await readGitHub(
      async (_cwd, args) => {
        seen.push(args);
        return args[0] === "repo" ? ok(JSON.stringify({ nameWithOwner: "o/r" })) : ok("[]");
      },
      "/repo",
      () => 1,
      { issues: { state: "all", milestone: "v2", labels: ["bug"] }, pulls: { state: "open", labels: [] } },
    );
    const issueCalls = seen.filter((args) => args[0] === "issue");
    expect(issueCalls).toHaveLength(2);
    // Identical but for the field list.
    const withoutFields = (args: string[]) => args.slice(0, args.indexOf("--json"));
    expect(withoutFields(issueCalls[0]!)).toEqual(withoutFields(issueCalls[1]!));
    expect(withoutFields(issueCalls[0]!)).toContain("--milestone");
  });
});

describe("readForgeFacets", () => {
  const facetRunner = (replies: Partial<Record<"milestones" | "assignees" | "user" | "label", GhResult>>): GhRunner =>
    async (_cwd, args) => {
      if (args[0] === "label") return replies.label ?? ok("[]");
      const path = args[1] ?? "";
      if (path.startsWith("repos/{owner}/{repo}/milestones")) return replies.milestones ?? ok("[]");
      if (path.startsWith("repos/{owner}/{repo}/assignees")) return replies.assignees ?? ok("[]");
      if (path === "user") return replies.user ?? ok("{}");
      return failed("unexpected");
    };

  test("reads the four lists a filter menu needs", async () => {
    const facets = await readForgeFacets(
      facetRunner({
        milestones: ok(JSON.stringify([{ title: "v2", open_issues: 4, closed_issues: 9 }, { title: "" }])),
        label: ok(JSON.stringify([{ name: "bug", color: "d73a4a" }])),
        assignees: ok(JSON.stringify([{ login: "ada" }, { login: "" }])),
        user: ok(JSON.stringify({ login: "grace" })),
      }),
      "/repo",
      () => 42,
    );
    expect(facets).toEqual({
      viewer: "grace",
      // A milestone with no title is dropped: it cannot be named on a chip and
      // `gh --milestone ""` is not a filter.
      milestones: [{ title: "v2", open: 4, closed: 9 }],
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["ada"],
      readAt: 42,
    });
  });

  test("EVERY LIST FAILS ALONE, and none of them is a failure of the others", async () => {
    // A repository with no milestones, a token that cannot list who is assignable,
    // and a gh that cannot answer are three situations that mean the same thing to a
    // menu: there is nothing to offer. None is a reason to break the others.
    const facets = await readForgeFacets(
      facetRunner({
        milestones: failed("HTTP 404"),
        assignees: failed("HTTP 403"),
        label: ok(JSON.stringify([{ name: "bug" }])),
        user: failed("HTTP 401"),
      }),
      "/repo",
      () => 1,
    );
    expect(facets.milestones).toEqual([]);
    expect(facets.assignees).toEqual([]);
    expect(facets.viewer).toBeUndefined();
    // The one that worked still worked.
    expect(facets.labels).toEqual([{ name: "bug" }]);
  });

  test("output the parsers cannot read is empty, not a throw", async () => {
    const facets = await readForgeFacets(
      facetRunner({ milestones: ok("<html>"), label: ok("<html>"), assignees: ok("{}"), user: ok("<html>") }),
      "/repo",
      () => 1,
    );
    expect(facets).toMatchObject({ milestones: [], labels: [], assignees: [] });
  });

  test("the lists are capped, because nobody scrolls a hundred-item menu", async () => {
    const many = Array.from({ length: MAX_FACET_VALUES + 20 }, (_unused, at) => ({ title: `m${at}`, open_issues: 0, closed_issues: 0 }));
    const facets = await readForgeFacets(facetRunner({ milestones: ok(JSON.stringify(many)) }), "/repo", () => 1);
    expect(facets.milestones).toHaveLength(MAX_FACET_VALUES);
  });
});

describe("the boards, in a call that can fail alone", () => {
  const ROWS = JSON.stringify([
    { number: 7, title: "a", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u" },
    { number: 9, title: "b", state: "OPEN", labels: [], updatedAt: "2026-08-01T00:00:00Z", url: "u" },
  ]);
  const BOARDS = JSON.stringify([
    { number: 7, projectItems: [{ title: "Roadmap" }, { title: "Sprint 4" }] },
    { number: 9, projectItems: [] },
  ]);

  /** Keyed by `<verb> <json fields>` so the board call and the row call can answer
   *  differently — which is the entire point of them being separate. */
  function boardRunner(board: GhResult): GhRunner {
    return async (_cwd, args) => {
      if (args[0] === "repo") return ok(JSON.stringify({ nameWithOwner: "o/r" }));
      const fields = args[args.indexOf("--json") + 1] ?? "";
      if (fields === "number,projectItems") return board;
      return ok(ROWS);
    };
  }

  test("board titles are folded onto the rows they belong to", async () => {
    const snapshot = await readGitHub(boardRunner(ok(BOARDS)), "/repo", () => 1);
    expect(snapshot.issues.find((issue) => issue.number === 7)!.projects).toEqual(["Roadmap", "Sprint 4"]);
    expect(snapshot.issues.find((issue) => issue.number === 9)!.projects).toEqual([]);
    expect(snapshot.projectsUnavailable).toBeUndefined();
  });

  test("A MISSING SCOPE COSTS THE COLUMN, NOT THE LIST", async () => {
    /**
     * The whole reason this is a separate call. Measured on this machine: a token
     * with `repo` and without `read:project` makes gh answer
     *
     *   GraphQL: Your token has not been granted the required scopes to execute
     *   this query. The 'id' field requires one of the following scopes:
     *   ['read:project'] …
     *
     * and it fails the ENTIRE `--json` query — so `projectItems` in the main field
     * list would blank the titles, the states and the assignees too.
     */
    const snapshot = await readGitHub(
      boardRunner(failed("GraphQL: Your token has not been granted the required scopes … ['read:project'] …")),
      "/repo",
      () => 1,
    );
    expect(snapshot.projectsUnavailable).toBe("scope");
    // The rows survived, in full.
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.issues[0]!.title).toBe("a");
    expect(snapshot.issues[0]!.projects).toEqual([]);
    expect(snapshot.unavailable).toBeUndefined();
  });

  test("a board failure that is NOT about scopes says so differently", async () => {
    // "Add the scope" and "GitHub was unwell" need different responses.
    const snapshot = await readGitHub(boardRunner(failed("HTTP 502")), "/repo", () => 1);
    expect(snapshot.projectsUnavailable).toBe("failed");
    expect(snapshot.issues).toHaveLength(2);
  });

  test("`skipProjects` asks nothing at all, and reports no reason", async () => {
    // Once a token has said it has no read:project, the store stops paying two
    // network calls per read to be told again — and an absent column with no
    // sentence is correct, because nothing was attempted.
    const seen: string[][] = [];
    const snapshot = await readGitHub(
      async (_cwd, args) => {
        seen.push(args);
        return args[0] === "repo" ? ok(JSON.stringify({ nameWithOwner: "o/r" })) : ok(ROWS);
      },
      "/repo",
      () => 1,
      { skipProjects: true },
    );
    expect(seen.some((args) => args.includes("number,projectItems"))).toBe(false);
    expect(snapshot.projectsUnavailable).toBeUndefined();
  });

  test("output the board parser cannot read is a failure, not silently no boards", async () => {
    const snapshot = await readGitHub(boardRunner(ok("<html>")), "/repo", () => 1);
    expect(snapshot.projectsUnavailable).toBe("failed");
  });
});

describe("parseProjectItems", () => {
  test("takes the title, and drops an item that has none", () => {
    const items = parseProjectItems(
      JSON.stringify([{ number: 4, projectItems: [{ title: "Roadmap" }, { title: "" }, { project: { title: "Nested" } }] }]),
    );
    expect(items.get(4)).toEqual(["Roadmap", "Nested"]);
  });

  test("a row on no boards is absent rather than an empty array", () => {
    // The caller defaults to `[]`, so an entry per unplaced row would be a map the
    // size of the repository for no information.
    const items = parseProjectItems(JSON.stringify([{ number: 4, projectItems: [] }]));
    expect(items.has(4)).toBe(false);
  });
});

describe("classifyProjectFailure", () => {
  test("the ordinary case is a scope, and it is named", () => {
    expect(classifyProjectFailure(failed("… requires one of the following scopes: ['read:project'] …"))).toBe("scope");
    expect(classifyProjectFailure(failed("HTTP 500"))).toBe("failed");
  });
});

// ── one issue, one pull request ─────────────────────────────────────────────

const iso = (day: number) => `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;

describe("parseComments", () => {
  test("orders by creation, so a capped thread keeps the NEWEST comments", () => {
    // The cap keeps a tail, and a tail is only the newest if the list is sorted.
    // It has always arrived sorted; relying on that would make the cap correct
    // only until it was not.
    const thread = parseComments([
      { url: "c3", body: "third", createdAt: iso(3) },
      { url: "c1", body: "first", createdAt: iso(1) },
      { url: "c2", body: "second", createdAt: iso(2) },
    ]);
    expect(thread.comments.map((entry) => entry.body)).toEqual(["first", "second", "third"]);
    expect(thread.olderComments).toBe(0);
  });

  test("a long thread is cut from the FRONT and says how many it dropped", () => {
    // Rendering three thousand markdown blocks into a 320px column locks the
    // window. The opening context is the issue BODY, which is carried whole, so
    // the newest comments are the ones worth the budget.
    const many = Array.from({ length: MAX_THREAD_COMMENTS + 5 }, (_unused, index) => ({
      url: `c${index}`,
      body: `#${index}`,
      createdAt: new Date(index * 1_000).toISOString(),
    }));
    const thread = parseComments(many);
    expect(thread.comments).toHaveLength(MAX_THREAD_COMMENTS);
    expect(thread.olderComments).toBe(5);
    // The last one is present and the first five are not — the cut is at the old end.
    expect(thread.comments.at(-1)!.body).toBe(`#${MAX_THREAD_COMMENTS + 4}`);
    expect(thread.comments[0]!.body).toBe("#5");
  });

  test("a comment GitHub hid stays hidden, with its reason", () => {
    // Rendering a spam-hidden comment in full beside the real ones shows a reader
    // something the repository decided to hide.
    const [comment] = parseComments([
      { url: "c1", body: "buy followers", createdAt: iso(1), isMinimized: true, minimizedReason: "SPAM", authorAssociation: "NONE" },
    ]).comments;
    expect(comment).toMatchObject({ minimized: true, minimizedReason: "SPAM", authorAssociation: "NONE" });
  });

  test("a comment with no url is dropped rather than rendered as a dead row", () => {
    expect(parseComments([{ body: "orphan", createdAt: iso(1) }]).comments).toEqual([]);
  });
});

describe("parseReviews", () => {
  test("keeps every round in order and flattens the author", () => {
    // Every review, not the latest per reviewer: hiding the round that requested
    // changes because a later one approved loses why it was approved.
    const reviews = parseReviews([
      { author: { login: "b" }, state: "APPROVED", body: "lgtm", submittedAt: iso(2) },
      { author: { login: "a" }, state: "CHANGES_REQUESTED", body: "no", submittedAt: iso(1) },
    ]);
    expect(reviews).toEqual([
      // …and its face, derived from that login: a review card sits in the same
      // timeline as a comment card and must not be the one without one (#790).
      { author: "a", authorAvatar: "https://github.com/a.png", state: "CHANGES_REQUESTED", body: "no", submittedAt: Date.parse(iso(1)) },
      { author: "b", authorAvatar: "https://github.com/b.png", state: "APPROVED", body: "lgtm", submittedAt: Date.parse(iso(2)) },
    ]);
  });

  test("a review with no state is not a review", () => {
    // It is neither an approval, a rejection nor a comment.
    expect(parseReviews([{ author: { login: "a" }, body: "?", submittedAt: iso(1) }])).toEqual([]);
  });
});

describe("parseChecks", () => {
  test("a check run keeps its own status, conclusion and workflow", () => {
    // Measured against a real pull request — these are the field names gh emits.
    expect(
      parseChecks([
        {
          __typename: "CheckRun",
          name: "lint",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://gh/job/1",
          workflowName: "Lint",
        },
      ]),
    ).toEqual([{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS", workflow: "Lint", url: "https://gh/job/1" }]);
  });

  test("a running check has NO conclusion, which is not the same as passing", () => {
    const [check] = parseChecks([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }]);
    expect(check).toEqual({ name: "test", status: "IN_PROGRESS" });
    expect(check!.conclusion).toBeUndefined();
  });

  test("a commit status is flattened into the same shape", () => {
    // The older API has `context`/`state`/`targetUrl` and no status of its own. A
    // client that had to know which of the two it was holding would grow a
    // `__typename` switch in every renderer.
    expect(
      parseChecks([
        { __typename: "StatusContext", context: "ci/build", state: "SUCCESS", targetUrl: "https://ci/1" },
        { __typename: "StatusContext", context: "ci/slow", state: "PENDING", targetUrl: "" },
        // ERROR becomes FAILURE: a check run has no ERROR conclusion, and every
        // reader would otherwise have to learn that a sixth word also means red.
        { __typename: "StatusContext", context: "ci/broken", state: "ERROR", targetUrl: "https://ci/3" },
        { __typename: "StatusContext", context: "ci/queued", state: "EXPECTED" },
      ]),
    ).toEqual([
      { name: "ci/build", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci/1" },
      { name: "ci/slow", status: "IN_PROGRESS" },
      { name: "ci/broken", status: "COMPLETED", conclusion: "FAILURE", url: "https://ci/3" },
      { name: "ci/queued", status: "QUEUED" },
    ]);
  });

  test("an entry this parser cannot name costs a row, not the panel", () => {
    // GitHub adding a third rollup type must degrade to one missing check.
    expect(parseChecks([{ __typename: "SomethingNew", mystery: true }, { name: "lint", status: "COMPLETED" }])).toEqual([
      { name: "lint", status: "COMPLETED" },
    ]);
  });
});

describe("parseJobId", () => {
  test("the Actions job is inside the check's details URL, and nowhere else", () => {
    // Measured: `gh`'s rollup carries the job only here.
    expect(parseJobId("https://github.com/cli/cli/actions/runs/18386406777/job/52385857117")).toBe("52385857117");
  });

  test("a URL that is not an Actions job has none, which is a normal answer", () => {
    // A commit status's `targetUrl` points at somebody else's dashboard; there is no
    // log for this cockpit to fetch and that is not a failure.
    expect(parseJobId("https://circleci.com/gh/o/r/1234")).toBeUndefined();
    expect(parseJobId("https://github.com/o/r/actions/runs/123")).toBeUndefined();
    expect(parseJobId("")).toBeUndefined();
  });
});

describe("parseCheckLog", () => {
  /** Two real lines, in `gh`'s actual shape — measured against a failing cli/cli job.
   *  The first carries a BOM. */
  const REAL = [
    "no-response / noResponse\tUNKNOWN STEP\t﻿2026-08-12T16:25:32.4355162Z Current runner version: '2.336.0'",
    "no-response / noResponse\tUNKNOWN STEP\t2026-08-12T16:25:32.4391472Z ##[group]Runner Image Provisioner",
  ].join("\n");

  test("strips the job, the step, the timestamp and the BOM", () => {
    // Every line arrives three times longer than its message, with the message last.
    // The job and step are already on the check that asked for this.
    expect(parseCheckLog(REAL).lines).toEqual(["Current runner version: '2.336.0'", "##[group]Runner Image Provisioner"]);
  });

  test("KEEPS THE TAIL, because the failure is at the bottom", () => {
    /**
     * `--log-failed` opens with the runner's image provisioner, its Azure region and
     * its worker id — measured. Capping from the front returns thirty lines about
     * Ubuntu and none about what broke.
     */
    const many = Array.from({ length: MAX_CHECK_LOG_LINES + 40 }, (_unused, at) => `line ${at}`).join("\n");
    const parsed = parseCheckLog(many);
    expect(parsed.lines).toHaveLength(MAX_CHECK_LOG_LINES);
    expect(parsed.truncated).toBe(true);
    expect(parsed.lines.at(-1)).toBe(`line ${MAX_CHECK_LOG_LINES + 39}`);
    expect(parsed.lines[0]).toBe("line 40");
  });

  test("blank lines are dropped rather than padding the cap", () => {
    expect(parseCheckLog("a\n\n   \nb").lines).toEqual(["a", "b"]);
  });

  test("a line with no prefix at all survives intact", () => {
    // Not every producer writes gh's three-column shape, and a slice on a tab that
    // is not there would eat the line.
    expect(parseCheckLog("plain failure text").lines).toEqual(["plain failure text"]);
  });
});

describe("readCheckLog", () => {
  test("a job with no failing STEP says so rather than showing an empty box", async () => {
    // A cancelled job, or one whose runner died, has an empty `--log-failed`.
    const read = await readCheckLog(async () => ok("   \n\n"), "/repo", "42");
    expect(read).toEqual({ unavailable: "This job has no failing step to show a log for." });
  });

  test("gh refusing carries its own words", async () => {
    expect(await readCheckLog(async () => failed("HTTP 404: Not Found"), "/repo", "42")).toEqual({ unavailable: "HTTP 404: Not Found" });
  });

  test("asks for the FAILING steps of one job, not the whole run", async () => {
    // A green job's full log is megabytes of nothing anybody asked about.
    const seen: string[][] = [];
    await readCheckLog(
      async (_cwd, args) => {
        seen.push(args);
        return ok("x\ty\t2026-01-01T00:00:00.0Z boom");
      },
      "/repo",
      "42",
    );
    expect(seen[0]).toEqual(["run", "view", "--job", "42", "--log-failed"]);
  });
});

describe("parseIssueDetail", () => {
  test("adds the body and the conversation to the same row the list parses", () => {
    // Both readers share `issueRow`, so a title cannot change when you click it.
    const issue = parseIssueDetail(
      JSON.stringify({
        number: 7,
        title: "Rail freezes",
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        author: { login: "ada" },
        body: "# steps",
        labels: [{ name: "bug" }],
        assignees: [{ login: "grace" }, { login: "alan" }],
        milestone: { title: "v2", description: "…" },
        comments: [{ url: "c1", body: "seen it", createdAt: iso(2), author: { login: "grace" } }],
        createdAt: iso(1),
        updatedAt: iso(3),
        closedAt: iso(3),
        url: "https://github.com/o/r/issues/7",
      }),
      9_999,
    );
    expect(issue).toMatchObject({
      number: 7,
      title: "Rail freezes",
      state: "CLOSED",
      stateReason: "NOT_PLANNED",
      body: "# steps",
      assignees: ["grace", "alan"],
      milestone: "v2",
      olderComments: 0,
      createdAt: Date.parse(iso(1)),
      closedAt: Date.parse(iso(3)),
      readAt: 9_999,
    });
    expect(issue.comments).toHaveLength(1);
  });

  test("an OPEN issue has no closing time — not a closing time of 1970", () => {
    // `epoch` answers 0 for an absent date, and 0 renders as January 1970.
    const issue = parseIssueDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(issue.closedAt).toBeUndefined();
    expect(issue.assignees).toEqual([]);
    expect(issue.milestone).toBeUndefined();
  });
});

describe("parsePullDetail", () => {
  test("carries both merge questions, the branch pair and the head commit", () => {
    // `mergeable` and `mergeStateStatus` are different questions: do the trees
    // combine, and will GitHub let you. A pull request can be both mergeable and
    // blocked.
    const pull = parsePullDetail(
      JSON.stringify({
        number: 12,
        title: "Ship it",
        state: "OPEN",
        isDraft: false,
        author: { login: "ada" },
        body: "why",
        labels: [{ name: "feature", color: "abc" }],
        assignees: [],
        baseRefName: "main",
        headRefName: "telar/x",
        headRefOid: "deadbeef",
        reviewDecision: "APPROVED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        additions: 40,
        deletions: 3,
        changedFiles: 2,
        comments: [],
        reviews: [{ author: { login: "grace" }, state: "APPROVED", body: "", submittedAt: iso(2) }],
        statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }],
        createdAt: iso(1),
        updatedAt: iso(2),
        url: "u",
      }),
      5,
    );
    expect(pull).toMatchObject({
      baseRefName: "main",
      headRefName: "telar/x",
      headRefOid: "deadbeef",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      labels: [{ name: "feature", color: "abc" }],
      additions: 40,
      deletions: 3,
      changedFiles: 2,
      readAt: 5,
    });
    expect(pull.reviews).toHaveLength(1);
    expect(pull.checks).toEqual([{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }]);
  });

  test("mergeability GitHub has not computed reads UNKNOWN, never blank", () => {
    // GitHub computes it lazily, so the first read of a quiet pull request
    // routinely has neither field — measured. `UNKNOWN` is its own word for "ask
    // again", and every client already handles it; an empty string is a fifth
    // state nobody has a branch for.
    const pull = parsePullDetail(JSON.stringify({ number: 1, title: "t", state: "OPEN", url: "u", createdAt: iso(1) }), 1);
    expect(pull.mergeable).toBe("UNKNOWN");
    expect(pull.mergeStateStatus).toBe("UNKNOWN");
    expect(pull.additions).toBe(0);
    expect(pull.mergedAt).toBeUndefined();
  });
});

describe("parseMergeMethods", () => {
  test("offers only what the repository allows", () => {
    // Measured on this repository, which allows merge commits and nothing else —
    // exactly the case where a squash button would refuse for a reason nobody
    // could have predicted from the screen.
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual(["merge"]);
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true }))).toEqual([
      "merge",
      "squash",
      "rebase",
    ]);
  });

  test("a read that failed offers ALL THREE, not none", () => {
    // Guessing generously costs one refusal that names itself; guessing meanly
    // costs a button that cannot be pressed for a reason nobody can see.
    expect(parseMergeMethods("")).toEqual(["merge", "squash", "rebase"]);
    expect(parseMergeMethods("<html>")).toEqual(["merge", "squash", "rebase"]);
  });

  test("a repository that allows none of them is honoured, not widened", () => {
    // `gh` saying "all off" is a different fact from `gh` not answering.
    expect(parseMergeMethods(JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }))).toEqual([]);
  });
});

describe("classifyDetailFailure", () => {
  test("a number nobody used is not a broken machine", () => {
    // gh: "GraphQL: Could not resolve to a PullRequest with the number of 999999"
    // — measured. Reporting that as `failed` would send a reader to check their
    // gh install over a typo.
    expect(classifyDetailFailure(failed("GraphQL: Could not resolve to a PullRequest with the number of 999999")).unavailable).toBe("not_found");
  });

  test("the list's four kinds of nothing still classify the same way", () => {
    expect(classifyDetailFailure(failed("", 127)).unavailable).toBe("not_installed");
    expect(classifyDetailFailure(failed("gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyDetailFailure(failed("HTTP 502")).unavailable).toBe("failed");
  });
});

describe("readIssue and readPull", () => {
  test("a failure is a typed answer with a sentence, not a throw", async () => {
    const read = await readIssue(runner({ issue: failed("gh: not logged in") }), "/repo", 4);
    expect(read).toEqual({ unavailable: "not_authenticated" });
  });

  test("output this engine cannot read is `failed`, not a crash", async () => {
    expect(await readPull(runner({ pr: ok("<html>") }), "/repo", 4)).toEqual({
      unavailable: "failed",
      message: "gh returned output this engine could not read",
    });
  });

  test("the happy path carries the read time", async () => {
    const read = await readIssue(
      runner({ issue: ok(JSON.stringify({ number: 4, title: "t", state: "OPEN", url: "u", createdAt: iso(1) })) }),
      "/repo",
      4,
      () => 777,
    );
    expect(read).toMatchObject({ issue: { number: 4, readAt: 777 } });
  });
});

/**
 * WHO WROTE EACH COMMENT — issue #814.
 *
 * THE DERIVATION IS BLIND ON A COMMENT AND THAT IS THE BUG. A ROW's author carries
 * `is_bot`; a COMMENT's is `{login}` and nothing else — measured, and no `gh` field
 * set can widen it. So `github.com/<login>.png` for a comment is a bet that no
 * human owns that slug, and GitHub hands out free logins: of ten bot commenters
 * swept across six large repositories, six 404 to a monogram TODAY and are one
 * signup away from a stranger's face, and four already resolve to the vendor's own
 * Organization rather than to the App.
 *
 * SO THE THREAD READ ASKS. One GraphQL call beside the detail read returns
 * `__typename`, the App's own installation avatar, and reaction viewer state that
 * `gh`'s projection drops.
 */
describe("the thread read asks GitHub who wrote each comment", () => {
  const THREAD = "https://github.com/o/r/issues/7";
  const AT = (n: number) => `${THREAD}#issuecomment-${n}`;
  /** The App's own face. Measured against cli/cli#14443 — `/in/` is an
   *  INSTALLATION avatar, which no login can be turned into. */
  const APP_FACE = "https://avatars.githubusercontent.com/in/3557673?v=4";

  /** What `gh issue view --json` answers: the bare slug, and no bot signal. */
  const detail = (comments: unknown[]) =>
    ok(JSON.stringify({ number: 7, title: "t", state: "OPEN", url: THREAD, createdAt: iso(1), comments }));

  /** What `gh api graphql` answers. */
  const graphql = (nodes: unknown[]) => ok(JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { nodes } } } } }));

  const NO_REACTIONS: unknown[] = [];

  async function thread(detailReply: GhResult, graphqlReply: GhResult) {
    const read = await readIssue(verbRunner({ "issue view": detailReply, "api graphql": graphqlReply }), "/repo", 7, () => 1, {
      skipProjects: true,
    });
    if (!("issue" in read)) throw new Error(`expected an issue, got ${read.unavailable}`);
    return read.issue;
  }

  test("A BOT WEARS THE APP'S OWN FACE, never the face of whoever owns that login", async () => {
    /**
     * THE PROOF, AND IT IS WRITTEN TO FAIL IF THE SECOND READ IS DELETED. Asserting
     * that `authorAvatar` is a non-empty string would pass with this read gone — the
     * derived URL is also a non-empty string. So it asserts PROVENANCE: the value is
     * the one GitHub sent, and it is NOT the one this engine could have invented.
     */
    const issue = await thread(
      detail([{ url: AT(1), body: "triaged", createdAt: iso(2), author: { login: "cli-triage" } }]),
      graphql([{ url: AT(1), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.author).toBe("cli-triage");
    expect(issue.comments[0]!.authorAvatar).toBe(APP_FACE);
    // The face the derivation would have produced: `github.com/cli-triage.png`, which
    // is a 404 today and one signup away from a person who never wrote this.
    expect(issue.comments[0]!.authorAvatar).not.toBe("https://github.com/cli-triage.png");
  });

  test("an App GitHub gives no face for gets NOTHING, not the slug's owner", async () => {
    // The answer "GitHub knows this is a Bot and has no image" must land as absent.
    // Falling through to the derivation here is the same bug with an extra step.
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "dependabot" } }]),
      graphql([{ url: AT(1), author: { __typename: "Bot", login: "dependabot" }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments[0]!.author).toBe("dependabot");
    expect(issue.comments[0]!.authorAvatar).toBeUndefined();
  });

  test("a deleted account is an ANSWER, and it suppresses the face too", async () => {
    // GitHub sends `author: null` for a deleted account. That is GitHub saying
    // there is nobody to show, not this read failing to ask.
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ghost" } }]),
      graphql([{ url: AT(1), author: null, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments[0]!.author).toBe("ghost");
    expect(issue.comments[0]!.authorAvatar).toBeUndefined();
  });

  test("a person's face is GitHub'S OWN URL, which is what makes this work off github.com", async () => {
    // On GitHub Enterprise Server this is that server's avatar host. Nothing in the
    // engine has to know the hostname, which is the second reason this is a read
    // and not a cleverer derivation.
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        { url: AT(1), author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/51800760?v=4" }, reactionGroups: NO_REACTIONS },
      ]),
    );
    expect(issue.comments[0]!.authorAvatar).toBe("https://avatars.githubusercontent.com/u/51800760?v=4");
  });

  test("A FAILED SECOND READ COSTS THE FACES, NOT THE ISSUE", async () => {
    // The `readBoards` bargain. The thread, the body and the states all survive, and
    // each comment falls back to the derivation that shipped in #790 — worse than
    // the read and better than a blank panel.
    const issue = await thread(detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]), failed("HTTP 502"));
    expect(issue.number).toBe(7);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
    // Absent, not `[]`: nothing was asked, so "nobody reacted" would be invented.
    expect(issue.comments[0]!.reactions).toBeUndefined();
  });

  test("output the thread read cannot be parsed from costs the faces and nothing else", async () => {
    const issue = await thread(detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]), ok("<html>"));
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
  });

  test("a comment the second read did not cover keeps the derivation, beside one that was", async () => {
    // The fold is BY URL and not by position: a thread longer than the cap, or one
    // that gained a comment between the two calls, must not shift faces onto the
    // wrong rows.
    const issue = await thread(
      detail([
        { url: AT(1), body: "older", createdAt: iso(2), author: { login: "ada" } },
        { url: AT(2), body: "newer", createdAt: iso(3), author: { login: "cli-triage" } },
      ]),
      graphql([{ url: AT(2), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
    );
    expect(issue.comments.map((entry) => entry.body)).toEqual(["older", "newer"]);
    expect(issue.comments[0]!.authorAvatar).toBe("https://github.com/ada.png");
    expect(issue.comments[1]!.authorAvatar).toBe(APP_FACE);
  });

  test("REACTIONS ARRIVE COUNTED, with the groups nobody used dropped", async () => {
    // GitHub answers all eight contents for every comment whether or not anybody
    // used them — measured. Carried whole, a comment nobody reacted to would
    // arrive as eight zeroes.
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        {
          url: AT(1),
          author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
          reactionGroups: [
            { content: "THUMBS_UP", viewerHasReacted: true, users: { totalCount: 3 } },
            { content: "THUMBS_DOWN", viewerHasReacted: false, users: { totalCount: 0 } },
            { content: "ROCKET", viewerHasReacted: false, users: { totalCount: 1 } },
          ],
        },
      ]),
    );
    expect(issue.comments[0]!.reactions).toEqual([
      { content: "THUMBS_UP", count: 3, viewerHasReacted: true },
      { content: "ROCKET", count: 1, viewerHasReacted: false },
    ]);
  });

  test("asked-and-nobody-reacted is `[]`, which is not the same as absent", async () => {
    const issue = await thread(
      detail([{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "ada" } }]),
      graphql([
        {
          url: AT(1),
          author: { __typename: "User", login: "ada", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
          reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: false, users: { totalCount: 0 } }],
        },
      ]),
    );
    expect(issue.comments[0]!.reactions).toEqual([]);
  });

  test("a PULL REQUEST's thread is read the same way, through the same query", async () => {
    const read = await readPull(
      verbRunner({
        "pr view": ok(
          JSON.stringify({
            number: 7,
            title: "t",
            state: "OPEN",
            isDraft: false,
            url: "https://github.com/o/r/pull/7",
            createdAt: iso(1),
            comments: [{ url: AT(1), body: "b", createdAt: iso(2), author: { login: "cli-triage" } }],
          }),
        ),
        "repo view": ok("{}"),
        "api graphql": graphql([{ url: AT(1), author: { __typename: "Bot", login: "cli-triage", avatarUrl: APP_FACE }, reactionGroups: NO_REACTIONS }]),
      }),
      "/repo",
      7,
      () => 1,
      { skipProjects: true },
    );
    if (!("pull" in read)) throw new Error(`expected a pull request, got ${read.unavailable}`);
    expect(read.pull.comments[0]!.authorAvatar).toBe(APP_FACE);
  });
});

describe("parseThreadAuthors", () => {
  const nodes = (entries: unknown[]) => JSON.stringify({ data: { repository: { issueOrPullRequest: { comments: { nodes: entries } } } } });

  test("folds by url, which is the identifier the two reads share", () => {
    // Measured: `gh issue view --json comments` and the GraphQL connection return
    // byte-identical `…#issuecomment-<id>` urls for the same comment.
    const authors = parseThreadAuthors(
      nodes([
        { url: "https://github.com/o/r/issues/7#issuecomment-1", author: { __typename: "User", login: "ada", avatarUrl: "https://a/1" }, reactionGroups: [] },
        { url: "https://github.com/o/r/issues/7#issuecomment-2", author: { __typename: "Bot", login: "app", avatarUrl: "https://a/in/2" }, reactionGroups: [] },
      ]),
    );
    expect(authors.size).toBe(2);
    expect(authors.get("https://github.com/o/r/issues/7#issuecomment-1")).toEqual({ login: "ada", avatarUrl: "https://a/1", reactions: [] });
    expect(authors.get("https://github.com/o/r/issues/7#issuecomment-2")!.avatarUrl).toBe("https://a/in/2");
  });

  test("a node with no url cannot be folded onto anything, and is dropped", () => {
    expect(parseThreadAuthors(nodes([{ author: { __typename: "User", login: "ada", avatarUrl: "https://a/1" } }])).size).toBe(0);
  });

  test("a null author is still an entry — GitHub answered, and the answer is nobody", () => {
    const authors = parseThreadAuthors(nodes([{ url: "c1", author: null, reactionGroups: [] }]));
    expect(authors.has("c1")).toBe(true);
    expect(authors.get("c1")).toEqual({ reactions: [] });
  });

  test("an answer with no thread in it is an empty map, not a throw", () => {
    // A number that resolves to neither an issue nor a pull request, and a partial
    // GraphQL error, both arrive shaped like this.
    expect(parseThreadAuthors(JSON.stringify({ data: { repository: { issueOrPullRequest: null } } })).size).toBe(0);
    expect(parseThreadAuthors(JSON.stringify({ data: null })).size).toBe(0);
  });
});

// ── merging ────────────────────────────────────────────────────────────────

/** An open, mergeable pull request at `head`. */
const mergeable = (over: Record<string, unknown> = {}) =>
  ok(
    JSON.stringify({
      number: 12,
      title: "Ship it",
      state: "OPEN",
      isDraft: false,
      url: "u",
      createdAt: iso(1),
      baseRefName: "main",
      headRefName: "telar/x",
      headRefOid: "head-1",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      ...over,
    }),
  );

describe("mergePull", () => {
  test("sends the method and PINS THE HEAD the reader reviewed", async () => {
    const seen: string[][] = [];
    const result = await mergePull(
      verbRunner({ "pr view": mergeable(), "pr merge": ok("") }, seen),
      "/repo",
      { number: 12, method: "squash", expectedHeadOid: "head-1" },
      () => 100,
    );
    expect(result.merged).toBe(true);
    // The argv, verbatim. `--match-head-commit` is the precondition: without it a
    // person reviews one diff, an agent pushes another commit, and the button
    // merges code nobody looked at.
    expect(seen.find((args) => args[1] === "merge")).toEqual(["pr", "merge", "12", "--squash", "--match-head-commit", "head-1"]);
    // And no --admin, no --auto, no --delete-branch: bypassing the repository's
    // own protection, merging later without the person, and deleting a branch a
    // session's worktree may be sitting on.
    const merge = seen.find((args) => args[1] === "merge")!;
    expect(merge.some((arg) => ["--admin", "--auto", "--delete-branch"].includes(arg))).toBe(false);
  });

  test("REPORTS THE PULL REQUEST AS IT IS AFTER THE MERGE, re-read", async () => {
    // Reporting the pre-merge record with a success flag is exactly the stale-
    // header bug the file editor had.
    const result = await mergePull(
      verbRunner({
        "pr view": [mergeable(), mergeable({ state: "MERGED", mergedAt: iso(4), mergedBy: { login: "ada" } })],
        "pr merge": ok(""),
      }),
      "/repo",
      { number: 12, method: "merge", expectedHeadOid: "head-1" },
      () => 100,
    );
    expect(result).toMatchObject({ merged: true, pull: { state: "MERGED", mergedBy: "ada" } });
  });

  test("a merge that WORKED and a confirming read that did not is still a merge", async () => {
    // Reporting a refusal here would be a lie about a merged pull request.
    const result = await mergePull(
      verbRunner({ "pr view": [mergeable(), failed("HTTP 502")], "pr merge": ok("") }, undefined),
      "/repo",
      { number: 12, method: "merge", expectedHeadOid: "head-1" },
      () => 4_242,
    );
    expect(result).toMatchObject({ merged: true, pull: { state: "MERGED", mergedAt: 4_242 } });
  });

  describe("refuses from the pull request's own fields, without asking GitHub", () => {
    /** Every case here must NOT reach `pr merge` — the runner has no reply for
     *  it, so a call would fail the assertion on `merged`. */
    const refuse = (view: GhResult, expected = "head-1") =>
      mergePull(verbRunner({ "pr view": view }), "/repo", { number: 12, method: "squash", expectedHeadOid: expected }, () => 1);

    test("a head that moved since the read", async () => {
      // The case the precondition exists for, caught before GitHub is asked.
      expect(await refuse(mergeable({ headRefOid: "head-2" }))).toMatchObject({
        merged: false,
        refusal: "head_moved",
        message: "A commit landed on telar/x after this page was read.",
      });
    });

    test("a pull request that is already merged", async () => {
      expect(await refuse(mergeable({ state: "MERGED", mergedAt: iso(2) }))).toMatchObject({
        merged: false,
        refusal: "not_open",
        message: "#12 was already merged.",
      });
    });

    test("a draft", async () => {
      expect(await refuse(mergeable({ isDraft: true }))).toMatchObject({ merged: false, refusal: "blocked" });
    });

    test("conflicting trees", async () => {
      expect(await refuse(mergeable({ mergeable: "CONFLICTING" }))).toMatchObject({
        merged: false,
        refusal: "conflicted",
        message: "#12 conflicts with main.",
      });
    });

    test("a merge GitHub says is blocked, from the FIELD rather than from gh's prose", async () => {
      // Measured: `gh` describes this same situation as "is not mergeable: the base
      // branch policy prohibits the merge", which reads like a conflict. One field
      // beats one sentence.
      expect(await refuse(mergeable({ mergeStateStatus: "BLOCKED" }))).toMatchObject({ merged: false, refusal: "blocked" });
    });

    test("mergeability GitHub has not computed yet is NOT a refusal", async () => {
      // `UNKNOWN` means ask again, not no. Refusing here would block every first
      // merge of a quiet pull request.
      const result = await mergePull(
        verbRunner({ "pr view": mergeable({ mergeable: "UNKNOWN" }), "pr merge": ok("") }),
        "/repo",
        { number: 12, method: "squash", expectedHeadOid: "head-1" },
        () => 1,
      );
      expect(result.merged).toBe(true);
    });

    test("a number nobody used", async () => {
      expect(await refuse(failed("GraphQL: Could not resolve to a PullRequest with the number of 12"))).toMatchObject({
        merged: false,
        refusal: "not_open",
      });
    });

    test("a read that failed for any other reason does not become a merge", async () => {
      // Nothing is known about the pull request, including whether merging it
      // would be safe.
      expect(await refuse(failed("HTTP 502"))).toMatchObject({ merged: false, refusal: "failed", message: "HTTP 502" });
    });
  });
});

describe("classifyMergeFailure", () => {
  test("BRANCH PROTECTION WEARING THE WORDS FOR A CONFLICT is not a conflict", () => {
    /**
     * gh's real message, measured against cli/cli#14120:
     *
     *   X Pull request cli/cli#14120 is not mergeable: the base branch policy
     *     prohibits the merge.
     *
     * The first version of this classifier matched "not mergeable" before
     * "branch policy" and told the reader to rebase a branch with nothing wrong
     * with it. Only driving the real thing found it, which is why the whole
     * sentence is pinned here rather than a phrase from it.
     */
    const real = failed(
      "X Pull request cli/cli#14120 is not mergeable: the base branch policy prohibits the merge.\nTo have the pull request merged after all the requirements have been met, add the `--auto` flag.",
    );
    expect(classifyMergeFailure(real).refusal).toBe("blocked");
  });

  test("names the refusals the engine could not decide from data", () => {
    expect(classifyMergeFailure(failed("Head branch was modified. Review and try the merge again.")).refusal).toBe("head_moved");
    expect(classifyMergeFailure(failed("Pull request is not mergeable: the merge commit cannot be cleanly created")).refusal).toBe("conflicted");
    expect(classifyMergeFailure(failed("Squash merges are not allowed on this repository")).refusal).toBe("method_not_allowed");
    expect(classifyMergeFailure(failed("Must have admin rights to Repository.")).refusal).toBe("not_permitted");
    expect(classifyMergeFailure(failed("At least 1 approving review is required by reviewers")).refusal).toBe("blocked");
    expect(classifyMergeFailure(failed("Pull request #12 was already merged")).refusal).toBe("not_open");
  });

  test("an unrecognised refusal keeps gh's own words rather than guessing", () => {
    // The same trade as `classifyGhFailure`: phrasing changes upstream, and
    // "here is what gh said" beats a confident wrong diagnosis. Every sentence
    // above is a phrase match, so this fallback is the one that has to be safe.
    expect(classifyMergeFailure(failed("something entirely new"))).toEqual({ refusal: "failed", message: "something entirely new" });
  });
});

/**
 * ATTRIBUTION — issue #791, the one thing github.com structurally cannot show.
 *
 * THE ROUND TRIP IS THE TEST, and it is written that way on purpose. A check
 * that a marker parses out of a HAND-BUILT body proves only that the test
 * author can type the marker; it stays green if `commentOn` stops stamping
 * altogether. So the body these assertions read is the one `commentOn` actually
 * handed `gh` — captured off the argv — and it goes back in through
 * `parseComments`, the same parser the panel uses.
 */
describe("comment attribution", () => {
  const SESSION = "session_db5cb38d5339445aa30d5d1b2fdd71a2";
  /** `gh` prints the new comment's URL and nothing else. */
  const posted = (url: string) => ok(`${url}\n`);

  /** The body `commentOn` built, taken from the argv it called `gh` with. */
  function bodyFrom(calls: string[][]): string {
    const call = calls.find((args) => args[1] === "comment");
    if (!call) throw new Error("commentOn never called gh");
    const at = call.indexOf("--body");
    return call[at + 1] ?? "";
  }

  /** That same body as `gh issue view --json comments` would hand it back. */
  const asThread = (body: string) => [{ body, createdAt: "2026-09-20T10:00:00Z", isMinimized: false, url: "https://example.invalid/c1" }];

  test("a comment the engine posted comes back naming the session that wrote it", async () => {
    const calls: string[][] = [];
    const result = await commentOn(verbRunner({ "issue comment": posted("https://example.invalid/issues/791#issuecomment-1") }, calls), "/repo", {
      kind: "issue",
      number: 791,
      body: "The finding, at length.",
      sessionId: SESSION,
    });

    expect(result).toEqual({
      posted: true,
      url: "https://example.invalid/issues/791#issuecomment-1",
      attribution: { sessionId: SESSION },
    });

    // THE ROUND TRIP. Through the real parser, on the real body.
    const read = parseComments(asThread(bodyFrom(calls)));
    expect(read.comments[0]!.attribution).toEqual({ sessionId: SESSION });
    // And the marker is gone from what a reader is handed.
    expect(read.comments[0]!.body).toBe("The finding, at length.");
    expect(read.comments[0]!.body).not.toContain("telar-session");
  });

  /**
   * THE FAILURE DIRECTION, which is what makes the test above mean anything: a
   * comment that did NOT go through the stamping parses to no attribution at
   * all. Revert `withSessionMarker` in `commentOn` and the test above fails
   * exactly here — it is the same assertion with the stamping removed.
   */
  test("a comment nobody stamped is attributed to nobody", () => {
    const read = parseComments(asThread("Posted by hand with `gh issue comment`."));
    expect(read.comments[0]!.attribution).toBeUndefined();
    expect(read.comments[0]!.body).toBe("Posted by hand with `gh issue comment`.");
  });

  test("nothing but the session id reaches github.com", async () => {
    const calls: string[][] = [];
    await commentOn(verbRunner({ "pr comment": posted("https://example.invalid/pull/1#issuecomment-2") }, calls), "/Volumes/Focaltec HD/live/Telar/worktree", {
      kind: "pull",
      number: 1,
      body: "Rebased onto main.",
      sessionId: SESSION,
    });
    const body = bodyFrom(calls);
    /**
     * THE PUBLICATION CHECK, against the whole argument rather than against the
     * marker alone: the cwd above is a real worktree path shape, and none of it
     * — nor the volume, nor the machine — may appear in what is posted.
     */
    expect(body).toBe(`Rebased onto main.\n\n<!-- telar-session: ${SESSION} -->`);
    for (const forbidden of ["/Volumes", "Focaltec", "/Users", "worktree", ".local", "@"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("a pull request comment is `pr comment`, an issue's is `issue comment`", async () => {
    const calls: string[][] = [];
    const gh = verbRunner(
      { "pr comment": posted("https://example.invalid/p"), "issue comment": posted("https://example.invalid/i") },
      calls,
    );
    await commentOn(gh, "/repo", { kind: "pull", number: 2, body: "a", sessionId: SESSION });
    await commentOn(gh, "/repo", { kind: "issue", number: 3, body: "b", sessionId: SESSION });
    expect(calls.map((args) => args.slice(0, 3).join(" "))).toEqual(["pr comment 2", "issue comment 3"]);
  });

  test("an empty or oversized body is refused before gh is asked", async () => {
    const calls: string[][] = [];
    const gh = verbRunner({ "issue comment": posted("https://example.invalid/i") }, calls);
    expect(await commentOn(gh, "/repo", { kind: "issue", number: 1, body: "   ", sessionId: SESSION })).toMatchObject({
      posted: false,
      refusal: "invalid_body",
    });
    const huge = await commentOn(gh, "/repo", { kind: "issue", number: 1, body: "x".repeat(MAX_COMMENT_BODY + 1), sessionId: SESSION });
    expect(huge).toMatchObject({ posted: false, refusal: "invalid_body" });
    expect(huge.posted === false && huge.message).toContain(String(MAX_COMMENT_BODY));
    // Neither reached GitHub.
    expect(calls).toEqual([]);
  });

  test("an id that is not publishable refuses rather than posting an unstamped comment", async () => {
    const calls: string[][] = [];
    const result = await commentOn(verbRunner({ "issue comment": posted("https://example.invalid/i") }, calls), "/repo", {
      kind: "issue",
      number: 1,
      body: "a finding",
      sessionId: "/Users/facundo/Library/Application Support/Telar",
    });
    expect(result).toMatchObject({ posted: false, refusal: "invalid_body" });
    // THE POINT: it did not fall back to posting the comment without a marker.
    expect(calls).toEqual([]);
  });

  test("gh's refusals are named, and an unfamiliar one keeps gh's words", () => {
    expect(classifyCommentFailure(failed("GraphQL: Could not resolve to an Issue with the number of 99999")).refusal).toBe("not_found");
    expect(classifyCommentFailure(failed("HTTP 403: Resource not accessible by integration")).refusal).toBe("not_permitted");
    expect(classifyCommentFailure(failed("Issue is locked. (HTTP 403)")).refusal).toBe("not_permitted");
    expect(classifyCommentFailure(failed("something entirely new"))).toEqual({ refusal: "failed", message: "something entirely new" });
  });

  test("a comment that posted without a readable url is still reported as posted", async () => {
    // `gh` printing something unfamiliar must not make a model post twice.
    const result = await commentOn(verbRunner({ "issue comment": ok("Comment created.\n") }), "/repo", {
      kind: "issue",
      number: 7,
      body: "a",
      sessionId: SESSION,
    });
    expect(result).toMatchObject({ posted: true, url: "#7", attribution: { sessionId: SESSION } });
    expect(parseCommentUrl("Comment created.\n")).toBeUndefined();
    expect(parseCommentUrl("https://example.invalid/x\n")).toBe("https://example.invalid/x");
  });
});
