/**
 * `github_status` — the one fact the Agent needs that is not a session's
 * (#541's owner decision 4).
 *
 * What must not drift:
 *
 *   - it is READ-ONLY, structurally: the capability has two methods and both
 *     are reads, so no prompt can merge, comment or close;
 *   - a number with no kind is tried as a pull request and falls back to the
 *     issue, because GitHub numbers both from one sequence;
 *   - a broken machine is reported as a sentence rather than retried as the
 *     other kind;
 *   - the answer is BOUNDED: a summary of the checks, the last comment's head,
 *     and never a thread;
 *   - one project resolves itself, several do not, and the refusal names them.
 */
import { expect, test } from "bun:test";
import { parseIssueDetail, parsePullDetail } from "../src/github";
import { agentGitHubTools, type AgentGitHubCapability } from "../src/agent/tools";
import { collectTools } from "../src/mcp-socket";

const PROJECTS = [{ id: "project_a", name: "telar" }];

/** `gh pr view --json …` as it really comes back, narrowed to the fields this
 *  tool reads. Parsed by the engine's own parser rather than hand-built, so a
 *  change to `parsePullDetail` is a change this test sees. */
const PULL_JSON = JSON.stringify({
  number: 562,
  title: "the phone asks for a language too",
  state: "OPEN",
  isDraft: false,
  author: { login: "Facundo-Barbera" },
  body: "the body",
  labels: [],
  assignees: [],
  baseRefName: "main",
  headRefName: "telar/dictation-language",
  headRefOid: "abc123",
  reviewDecision: "APPROVED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  additions: 210,
  deletions: 14,
  changedFiles: 6,
  comments: [
    { author: { login: "someone" }, body: "first", createdAt: "2026-09-16T10:00:00Z", isMinimized: false, url: "https://example.invalid/1" },
    {
      author: { login: "Facundo-Barbera" },
      body: `${"the last word on this, at length. ".repeat(40)}`,
      createdAt: "2026-09-16T11:00:00Z",
      isMinimized: false,
      url: "https://example.invalid/2",
    },
  ],
  reviews: [],
  statusCheckRollup: [
    { name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "ci" },
    { name: "test", status: "COMPLETED", conclusion: "FAILURE", workflowName: "ci" },
    { name: "lint", status: "IN_PROGRESS", workflowName: "ci" },
  ],
  createdAt: "2026-09-15T10:00:00Z",
  updatedAt: "2026-09-16T11:00:00Z",
  url: "https://example.invalid/pull/562",
});

const ISSUE_JSON = JSON.stringify({
  number: 541,
  title: "Agent v2 design",
  state: "OPEN",
  author: { login: "Facundo-Barbera" },
  body: "the design",
  labels: [{ name: "enhancement" }],
  assignees: [],
  comments: [{ author: { login: "Facundo-Barbera" }, body: "Owner decisions 2026-09-16", createdAt: "2026-09-16T09:00:00Z", isMinimized: false, url: "https://example.invalid/c" }],
  createdAt: "2026-09-10T10:00:00Z",
  updatedAt: "2026-09-16T09:00:00Z",
  url: "https://example.invalid/issues/541",
});

function wall(capability: Partial<AgentGitHubCapability>) {
  const full: AgentGitHubCapability = {
    issue: async () => ({ unavailable: "not_found" }),
    pull: async () => ({ unavailable: "not_found" }),
    projects: async () => PROJECTS,
    ...capability,
  };
  return collectTools(agentGitHubTools as never, full as never).find((tool) => tool.name === "github_status")!;
}

const answerOf = (result: { content: unknown[] }) => JSON.parse(String((result.content[0] as { text: string }).text));
const textOf = (result: { content: unknown[] }) => String((result.content[0] as { text: string }).text);

test("a pull request answers state, checks, mergeable and the last comment's head", async () => {
  const tool = wall({ pull: async () => ({ pull: parsePullDetail(PULL_JSON, 1) }) });
  const answer = answerOf(await tool.run({ number: 562 }));

  expect(answer.kind).toBe("pull");
  expect(answer.number).toBe(562);
  expect(answer.state).toBe("OPEN");
  // GitHub's own words, unmapped, and the two ARE different questions.
  expect(answer.mergeable).toBe("MERGEABLE");
  expect(answer.mergeState).toBe("BLOCKED");
  expect(answer.review).toBe("APPROVED");
  expect(answer.checks).toMatchObject({ total: 3, running: 1, failing: ["test"] });
  expect(answer.checks.green).toBeUndefined();
  expect(answer.changed).toEqual({ files: 6, additions: 210, deletions: 14 });
  // BOUNDED: the head of the last comment, not the thread.
  expect(answer.lastComment.by).toBe("Facundo-Barbera");
  expect(answer.lastComment.head.length).toBeLessThanOrEqual(300);
  expect(answer.comments).toBe(2);
  expect(textOf(await tool.run({ number: 562 })).length).toBeLessThan(2_000);
});

test("green is said out loud, and so is no checks at all", async () => {
  const green = JSON.parse(PULL_JSON) as Record<string, unknown>;
  green.statusCheckRollup = [{ name: "typecheck", status: "COMPLETED", conclusion: "SUCCESS" }];
  expect(answerOf(await wall({ pull: async () => ({ pull: parsePullDetail(JSON.stringify(green), 1) }) }).run({ number: 1 })).checks.green).toBe(true);

  green.statusCheckRollup = [];
  expect(answerOf(await wall({ pull: async () => ({ pull: parsePullDetail(JSON.stringify(green), 1) }) }).run({ number: 1 })).checks).toBe("none ran");
});

test("a number with no kind is tried as a pull request, then as an issue", async () => {
  const asked: string[] = [];
  const tool = wall({
    pull: async () => {
      asked.push("pull");
      return { unavailable: "not_found" };
    },
    issue: async () => {
      asked.push("issue");
      return { issue: parseIssueDetail(ISSUE_JSON, 1) };
    },
  });
  const answer = answerOf(await tool.run({ number: 541 }));
  expect(asked).toEqual(["pull", "issue"]);
  expect(answer.kind).toBe("issue");
  expect(answer.title).toBe("Agent v2 design");
  expect(answer.labels).toEqual(["enhancement"]);
  expect(answer.lastComment.head).toContain("Owner decisions");
});

test("naming the kind asks once and refuses once", async () => {
  const asked: string[] = [];
  const tool = wall({
    pull: async () => {
      asked.push("pull");
      return { unavailable: "not_found" };
    },
    issue: async () => {
      asked.push("issue");
      return { issue: parseIssueDetail(ISSUE_JSON, 1) };
    },
  });
  const refused = await tool.run({ number: 999, kind: "pull" });
  expect(asked).toEqual(["pull"]);
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("no pull request #999");
});

test("a broken machine is a sentence, not a second guess at the other kind", async () => {
  const asked: string[] = [];
  const tool = wall({
    pull: async () => {
      asked.push("pull");
      return { unavailable: "not_authenticated" };
    },
    issue: async () => {
      asked.push("issue");
      return { issue: parseIssueDetail(ISSUE_JSON, 1) };
    },
  });
  const refused = await tool.run({ number: 541 });
  expect(asked).toEqual(["pull"]);
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("nobody is signed in");
});

test("gh missing altogether says so in words a person can act on", async () => {
  const refused = await wall({ pull: async () => ({ unavailable: "not_installed" }) }).run({ number: 1, kind: "pull" });
  expect(textOf(refused)).toContain("gh CLI is not installed");
});

test("one project resolves itself; several must be named, and the refusal names them", async () => {
  const single = wall({ pull: async () => ({ pull: parsePullDetail(PULL_JSON, 1) }) });
  expect((await single.run({ number: 562 })).isError).toBeUndefined();

  const many = wall({
    projects: async () => [
      { id: "project_a", name: "telar" },
      { id: "project_b", name: "telar-vr" },
    ],
  });
  const refused = await many.run({ number: 562 });
  expect(refused.isError).toBe(true);
  expect(textOf(refused)).toContain("telar (project_a)");
  expect(textOf(refused)).toContain("telar-vr (project_b)");

  const none = wall({ projects: async () => [] });
  expect(textOf(await none.run({ number: 1 }))).toContain("no projects");
});

test("the project named wins, and nothing else is consulted", async () => {
  const seen: string[] = [];
  const tool = wall({
    projects: async () => {
      seen.push("projects");
      return [];
    },
    pull: async (projectId) => {
      seen.push(projectId);
      return { pull: parsePullDetail(PULL_JSON, 1) };
    },
  });
  await tool.run({ number: 562, projectId: "project_b" });
  expect(seen).toEqual(["project_b"]);
});

test("the wall carries one GitHub tool and it reads", () => {
  const tools = collectTools(agentGitHubTools as never, { issue: async () => ({}), pull: async () => ({}), projects: async () => [] } as never);
  expect(tools.map((tool) => tool.name)).toEqual(["github_status"]);
  expect(tools[0]!.description).toContain("Read-only");
  // Nothing on this wall writes: there is no second verb to reach for.
  expect(JSON.stringify(tools[0]!.shape)).not.toContain("merge");
});
