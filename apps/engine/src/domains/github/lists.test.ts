import { describe, expect, test } from "bun:test";
import { classifyDetailFailure, parseIssueDetail, parsePullDetail, readIssue, readPull } from "./detail";
import { classifyGhFailure, defaultGhRunner, type GhResult, type GhRunner, parseRepoFromUrl } from "./gh";
import { classifyProjectFailure, listArgv, MAX_FACET_VALUES, parseIssues, parseProjectItems, parsePulls, readForgeFacets, readGitHub } from "./lists";
import { MAX_THREAD_COMMENTS, parseComments, parseReviews } from "./threads";
import { failed, ok, runner } from "./test-helpers";

describe("classifyGhFailure", () => {
  test("tells the five kinds of nothing apart", () => {
    expect(classifyGhFailure(failed("", 127)).unavailable).toBe("not_installed");
    expect(classifyGhFailure(failed("gh: To get started with GitHub CLI, please run: gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyGhFailure(failed("failed to run git: fatal: not a git repository")).unavailable).toBe("no_repository");
    expect(classifyGhFailure(failed("failed to run git: no git remotes found")).unavailable).toBe("no_repository");
  });

  test("A CHECKOUT THAT DOES NOT EXIST ON THIS MACHINE IS NOT A MISSING `gh`", async () => {
    const missing = "/nonexistent/dir/for/test";
    const result = await defaultGhRunner(missing, ["--version"]);
    expect(result.status).toBe(126);
    expect(result.stderr).toContain(missing);
    expect(classifyGhFailure(result).unavailable).toBe("no_checkout");
  });

  test("A REPOSITORY THAT IS NOT ON GITHUB IS NOT A MISSING REPOSITORY — #670", () => {
    const real = failed(
      "none of the git remotes configured for this repository point to a known GitHub host. " +
        "To tell gh about a new GitHub host, please use `gh auth login`",
    );
    expect(classifyGhFailure(real).unavailable).toBe("not_github");
    expect(classifyGhFailure(failed("gh: To get started with GitHub CLI, please run: gh auth login")).unavailable).toBe("not_authenticated");
    expect(classifyGhFailure(failed("failed to run git: fatal: not a git repository")).unavailable).toBe("no_repository");
  });

  test("the split reaches a detail read too, which shares the classifier", () => {
    const real = failed("none of the git remotes configured for this repository point to a known GitHub host.");
    expect(classifyDetailFailure(real).unavailable).toBe("not_github");
  });

  test("an unrecognised failure keeps gh's own words rather than guessing", () => {
    const result = classifyGhFailure(failed("HTTP 403: API rate limit exceeded"));
    expect(result.unavailable).toBe("failed");
    expect(result.message).toBe("HTTP 403: API rate limit exceeded");
  });
});

describe("parseIssues", () => {
  test("a row carries everything a list can show without a second read", () => {
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
      authorAvatar: "https://github.com/ada.png",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["grace"],
      milestone: "v2",
      projects: [],
      linkedPulls: [],
      updatedAt: Date.parse("2026-08-08T18:54:57Z"),
      url: "https://github.com/o/r/issues/82",
    });
  });

  test("a closed row says WHY it closed", () => {
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

describe("the author's face", () => {
  const rowWith = (author: unknown) =>
    parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u", updatedAt: DAY, author }]))[0]!;

  test("comes from the login, because gh sends no avatar field to read", () => {
    expect(rowWith({ login: "ada", name: "Ada L", id: "MDQ6VXNlcjE=", is_bot: false })).toMatchObject({
      author: "ada",
      authorAvatar: "https://github.com/ada.png",
    });
    expect(rowWith({ login: "ada" }).authorAvatar).not.toContain("size=");
  });

  test("A BOT GETS NO FACE, because the derived URL is WRONG for one rather than slow", () => {
    expect(rowWith({ login: "app/renovate", is_bot: true }).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "app/renovate" }).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "renovate", is_bot: true }).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "app/renovate", is_bot: true }).author).toBe("app/renovate");
  });

  test("no author at all is no face, not a URL with a hole in it", () => {
    expect(rowWith(null).authorAvatar).toBeUndefined();
    expect(rowWith({ login: "" }).authorAvatar).toBeUndefined();
  });

  test("a login is escaped into the URL rather than pasted into it", () => {
    expect(rowWith({ login: "a b/c" }).authorAvatar).toBe("https://github.com/a%20b%2Fc.png");
  });

  test("a comment and a review carry it the same way a row does", () => {
    const thread = parseComments([{ url: "c1", body: "b", createdAt: DAY, author: { login: "grace" } }]);
    expect(thread.comments[0]).toMatchObject({ author: "grace", authorAvatar: "https://github.com/grace.png" });
    const reviews = parseReviews([{ author: { login: "alan" }, state: "APPROVED", body: "", submittedAt: DAY }]);
    expect(reviews[0]).toMatchObject({ author: "alan", authorAvatar: "https://github.com/alan.png" });
  });

  describe("and it is only derived for a github.com forge", () => {
    const GHES = "https://ghe.corp.example/o/r/issues/1";
    const faceFor = (url: string) =>
      parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url, updatedAt: DAY, author: { login: "ada" } }]))[0]!.authorAvatar;

    test("a row from another host gets the login and NO face", () => {
      const row = parseIssues(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: GHES, updatedAt: DAY, author: { login: "jsmith" } }]))[0]!;
      expect(row.author).toBe("jsmith");
      expect(row.authorAvatar).toBeUndefined();
    });

    test("a comment and a review from another host do too", () => {
      const thread = parseComments([{ url: `${GHES}#issuecomment-1`, body: "b", createdAt: DAY, author: { login: "jsmith" } }]);
      expect(thread.comments[0]!.author).toBe("jsmith");
      expect(thread.comments[0]!.authorAvatar).toBeUndefined();
      const reviews = parseReviews([{ author: { login: "jsmith" }, state: "APPROVED", body: "", submittedAt: DAY }], GHES);
      expect(reviews[0]!.authorAvatar).toBeUndefined();
    });

    test("github.com itself, and its www alias, still derive", () => {
      expect(faceFor("https://github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
      expect(faceFor("http://github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
      expect(faceFor("https://www.github.com/o/r/issues/1")).toBe("https://github.com/ada.png");
    });

    test("a url that names NO host contradicts nothing, and still derives", () => {
      expect(rowWith({ login: "ada" }).authorAvatar).toBe("https://github.com/ada.png");
      expect(faceFor("/o/r/issues/1")).toBe("https://github.com/ada.png");
    });

    test("a lookalike host is NOT github.com", () => {
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

describe("the issue↔PR link", () => {
  const ref = (number: number, owner = "NovarixHQ", name = "Telar", kind = "pull") => ({
    id: `PR_${number}`,
    number,
    url: `https://github.com/${owner}/${name}/${kind}/${number}`,
    repository: { id: "R_1", name, owner: { id: "U_1", login: owner } },
  });

  const issueWith = (refs: unknown, url = "https://github.com/NovarixHQ/Telar/issues/488") =>
    parseIssues(JSON.stringify([{ number: 488, title: "t", state: "CLOSED", url, updatedAt: DAY, closedByPullRequestsReferences: refs }]))[0]!;
  const pullWith = (refs: unknown, url = "https://github.com/NovarixHQ/Telar/pull/786") =>
    parsePulls(JSON.stringify([{ number: 786, title: "t", state: "MERGED", url, updatedAt: DAY, closingIssuesReferences: refs }]))[0]!;

  test("an issue names the pull requests linked to close it", () => {
    expect(issueWith([ref(786)]).linkedPulls).toEqual([{ number: 786, url: "https://github.com/NovarixHQ/Telar/pull/786" }]);
  });

  test("and a pull request names the issues it closes — the same relation, other end", () => {
    expect(pullWith([ref(488, "NovarixHQ", "Telar", "issues")]).linkedIssues).toEqual([
      { number: 488, url: "https://github.com/NovarixHQ/Telar/issues/488" },
    ]);
  });

  test("THE SAME REPOSITORY CARRIES NO `repository`, AND THAT IS THE JUMPABLE SIGNAL", () => {
    expect(issueWith([ref(786)]).linkedPulls[0]!.repository).toBeUndefined();
  });

  test("ANOTHER repository keeps its name, so a jump cannot open the wrong #768", () => {
    const linked = issueWith([ref(768, "other", "repo")]).linkedPulls[0]!;
    expect(linked).toEqual({ number: 768, url: "https://github.com/other/repo/pull/768", repository: "other/repo" });
  });

  test("a URL this engine cannot read makes every link a link OUT, not a wrong jump", () => {
    expect(parseRepoFromUrl("https://github.com/o/r/issues/7")).toBe("o/r");
    expect(parseRepoFromUrl("https://github.com/o/r/pull/7")).toBe("o/r");
    expect(parseRepoFromUrl("")).toBeUndefined();
    expect(parseRepoFromUrl("#488")).toBeUndefined();
    expect(issueWith([ref(786)], "").linkedPulls[0]!.repository).toBe("NovarixHQ/Telar");
  });

  test("a reference with no number is dropped, the way a row with no number is", () => {
    expect(issueWith([{ url: "u" }, ref(786)]).linkedPulls.map((link) => link.number)).toEqual([786]);
    expect(issueWith(undefined).linkedPulls).toEqual([]);
    expect(issueWith(null).linkedPulls).toEqual([]);
    expect(issueWith("nonsense").linkedPulls).toEqual([]);
  });

  test("a reference gh sent without a url still identifies itself by number", () => {
    expect(issueWith([{ number: 786 }]).linkedPulls).toEqual([{ number: 786, url: "#786" }]);
  });

  test("a DETAIL read carries the link, so it cannot disagree with the row you clicked", () => {
    const issue = parseIssueDetail(
      JSON.stringify({
        number: 488,
        title: "t",
        state: "CLOSED",
        url: "https://github.com/NovarixHQ/Telar/issues/488",
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
        url: "https://github.com/NovarixHQ/Telar/pull/786",
        createdAt: DAY,
        closingIssuesReferences: [ref(488, "NovarixHQ", "Telar", "issues")],
      }),
      1,
    );
    expect(pull.linkedIssues.map((link) => link.number)).toEqual([488]);
  });
});

describe("parsePulls", () => {
  test("keeps the head branch and GitHub's own review vocabulary", () => {
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
    const [open] = parsePulls(JSON.stringify([{ number: 1, title: "t", state: "OPEN", url: "u", updatedAt: "2026-01-01T00:00:00Z" }]));
    expect(open!.mergedAt).toBeUndefined();
    const [landed] = parsePulls(
      JSON.stringify([{ number: 2, title: "t", state: "MERGED", mergedAt: "2026-08-04T00:00:00Z", url: "u", updatedAt: "2026-08-04T00:00:00Z" }]),
    );
    expect(landed!.mergedAt).toBe(Date.parse("2026-08-04T00:00:00Z"));
  });

  test("a pull request row carries labels, which it never used to", () => {
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
    const snapshot = await readGitHub(runner({ issue: ok("<html>"), pr: ok("[]"), repo: failed("") }), "/repo", () => 0);
    expect(snapshot.unavailable).toBe("failed");
    expect(snapshot.repository).toBeUndefined();
  });
});

describe("which rows a list read asks for", () => {
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
    const seen = await argvFor({ issues: { state: "closed", labels: [] }, pulls: { state: "merged", labels: [] } });
    const state = (verb: string) => {
      const args = seen.find((entry) => entry[0] === verb && entry[1] === "list" && entry.includes("--state"))!;
      return args[args.indexOf("--state") + 1];
    };
    expect(state("issue")).toBe("closed");
    expect(state("pr")).toBe("merged");
  });

  test("the snapshot echoes back the WHOLE filter, not just the state", async () => {
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

describe("what the field sets ask gh for", () => {
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
    const list = await fieldsFor((gh) => readGitHub(gh, "/repo", () => 1, { skipProjects: true }));
    expect(list.get("issue list")).toContain("author");
    expect(list.get("pr list")).toContain("author");

    const issue = await fieldsFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(issue.get("issue view")).toContain("author");
    const pull = await fieldsFor((gh) => readPull(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(pull.get("pr view")).toContain("author");
  });

  test("and for the issue↔PR link, under the name gh has for it on THAT verb", async () => {
    const list = await fieldsFor((gh) => readGitHub(gh, "/repo", () => 1, { skipProjects: true }));
    expect(list.get("issue list")).toContain("closedByPullRequestsReferences");
    expect(list.get("issue list")).not.toContain("closingIssuesReferences");
    expect(list.get("pr list")).toContain("closingIssuesReferences");
    expect(list.get("pr list")).not.toContain("closedByPullRequestsReferences");

    const issue = await fieldsFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(issue.get("issue view")).toContain("closedByPullRequestsReferences");
    const pull = await fieldsFor((gh) => readPull(gh, "/repo", 7, () => 1, { skipProjects: true }));
    expect(pull.get("pr view")).toContain("closingIssuesReferences");
  });

  describe("the thread read", () => {
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
        expect(thread.query).toContain("__typename");
        expect(thread.query).toContain("avatarUrl");
        expect(thread.query).toContain("reactionGroups");
        expect(thread.query).toContain("viewerHasReacted");
      }
    });

    test("it asks for THIS number, at the engine's own cap, against gh's own repository placeholders", async () => {
      const thread = await threadReadFor((gh) => readIssue(gh, "/repo", 7, () => 1, { skipProjects: true }));
      expect(thread.variable("number")).toBe("7");
      expect(thread.variable("last")).toBe(String(MAX_THREAD_COMMENTS));
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
      "--label",
      "bug",
      "--label",
      "web",
      "--json",
      "number",
    ]);
  });

  test("MILESTONE IS DROPPED FOR PULL REQUESTS, because gh has no such flag there", () => {
    const argv = listArgv("pr", { state: "open", milestone: "v2", labels: [] } as never, "number");
    expect(argv).not.toContain("--milestone");
    expect(argv).toEqual(["pr", "list", "--state", "open", "--limit", "50", "--json", "number"]);
  });

  test("an unfiltered read sends no filter flags at all", () => {
    expect(listArgv("issue", { state: "open", labels: [] }, "f")).toEqual(["issue", "list", "--state", "open", "--limit", "50", "--json", "f"]);
  });

  test("THE BOARD CALL USES THE SAME FILTER as its rows", async () => {
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
      milestones: [{ title: "v2", open: 4, closed: 9 }],
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: ["ada"],
      readAt: 42,
    });
  });

  test("EVERY LIST FAILS ALONE, and none of them is a failure of the others", async () => {
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
    const snapshot = await readGitHub(
      boardRunner(failed("GraphQL: Your token has not been granted the required scopes … ['read:project'] …")),
      "/repo",
      () => 1,
    );
    expect(snapshot.projectsUnavailable).toBe("scope");
    expect(snapshot.issues).toHaveLength(2);
    expect(snapshot.issues[0]!.title).toBe("a");
    expect(snapshot.issues[0]!.projects).toEqual([]);
    expect(snapshot.unavailable).toBeUndefined();
  });

  test("a board failure that is NOT about scopes says so differently", async () => {
    const snapshot = await readGitHub(boardRunner(failed("HTTP 502")), "/repo", () => 1);
    expect(snapshot.projectsUnavailable).toBe("failed");
    expect(snapshot.issues).toHaveLength(2);
  });

  test("`skipProjects` asks nothing at all, and reports no reason", async () => {
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
