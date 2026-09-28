import { expect, test } from "bun:test";
import fs from "node:fs";
import { EngineStateError, EngineStore } from "../../state";
import { useTempStores } from "../../../test/temp-store";

const { root } = useTempStores();

/** Whether a `gh` argv is the BOARD half of a read — the one asking for
 *  `projectItems`, which is separate precisely so it can fail alone. */
const isBoardCall = (args: string[]) => args.includes("number,projectItems");
/** The thread read (#814) — who wrote each comment. Like the board call it rides
 *  beside a detail read and fails alone, so a test counting "how many times was
 *  this issue fetched" must not count it. */
const isThreadCall = (args: string[]) => args[0] === "api" && args[1] === "graphql";

test("a GitHub read is cached, and only a refresh gets past the cache", async () => {
  // The one cached read in this store, because it is the one that costs
  // somebody else's rate limit. A panel opened, closed and reopened must not
  // spend five API calls per glance.
  let calls = 0;
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "[]", stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  // FIVE, ALL AT ONCE: the two lists, the repository name, and the two board reads.
  await store.github.list("project_one");
  expect(calls).toBe(5);
  await store.github.list("project_one");
  expect(calls).toBe(5);

  // The refresh button is the only thing that may bypass it; a timer must not.
  await store.github.list("project_one", { force: true });
  expect(calls).toBe(10);

  clock += 31_000;
  await store.github.list("project_one");
  expect(calls).toBe(15);
});

test("WHICH ROWS is part of the cache key, so a filter cannot be answered by the wrong list", async () => {
  // Without the states in the key, switching Pull requests from open to all is
  // answered instantly from a cache of open ones — a filter that silently does
  // nothing for thirty seconds, which is worse than a slow one.
  let calls = 0;
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : "[]", stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  const open = { state: "open" as const, labels: [] };
  await store.github.list("project_one", { issues: open, pulls: open });
  expect(calls).toBe(5);
  await store.github.list("project_one", { issues: open, pulls: { state: "all", labels: [] } });
  expect(calls).toBe(10);
  // And the first combination is still cached, so going back is free.
  await store.github.list("project_one", { issues: open, pulls: open });
  expect(calls).toBe(10);

  // EVERY FIELD IS IN THE KEY, not just the state: a milestone filter answered from
  // a cache of everybody's issues is a filter that silently does nothing.
  await store.github.list("project_one", { issues: { state: "open", milestone: "v2", labels: [] }, pulls: open });
  expect(calls).toBe(15);
  await store.github.list("project_one", { issues: { state: "open", assignee: "@me", labels: [] }, pulls: open });
  expect(calls).toBe(20);

  // BUT LABELS IN A DIFFERENT ORDER ARE THE SAME QUESTION. `gh` ANDs them, so
  // without normalising, picking `bug` then `web` and `web` then `bug` would spend
  // two network reads to get identical rows.
  await store.github.list("project_one", { issues: { state: "open", labels: ["bug", "web"] }, pulls: open });
  expect(calls).toBe(25);
  await store.github.list("project_one", { issues: { state: "open", labels: ["web", "bug"] }, pulls: open });
  expect(calls).toBe(25);
});

test("what there is to FILTER BY is its own cache, and a longer one", async () => {
  // Milestones and labels change on the timescale of a sprint, not of a page view,
  // and nothing asks for them until a filter menu opens.
  let calls = 0;
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls += 1;
      return { status: 0, stdout: args[0] === "label" ? "[]" : args[1] === "user" ? "{}" : "[]", stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  await store.github.facetsOf("project_one");
  expect(calls).toBe(4);
  await store.github.facetsOf("project_one");
  expect(calls).toBe(4);

  // Past the LIST cache's thirty seconds and still fresh — this is the whole point
  // of it being separate.
  clock += 60_000;
  await store.github.facetsOf("project_one");
  expect(calls).toBe(4);

  clock += 5 * 60_000;
  await store.github.facetsOf("project_one");
  expect(calls).toBe(8);
});

test("a token with no read:project is asked ONCE, then left alone", async () => {
  // Two extra network calls per read, to be told the same thing every time, is a
  // toll on somebody whose token is simply scoped the ordinary way.
  const seen: string[][] = [];
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      seen.push(args);
      if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      if (isBoardCall(args)) return { status: 1, stdout: "", stderr: "requires one of the following scopes: ['read:project']" };
      return { status: 0, stdout: "[]", stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  const first = await store.github.list("project_one");
  expect(first.projectsUnavailable).toBe("scope");
  expect(seen.filter(isBoardCall)).toHaveLength(2);

  // A different filter is a fresh read, and it must not ask again.
  const second = await store.github.list("project_one", { pulls: { state: "all", labels: [] } });
  expect(seen.filter(isBoardCall)).toHaveLength(2);
  // But the reason survives: not re-asking must not unlearn the answer, or the panel can't explain the missing boards.
  expect(second.projectsUnavailable).toBe("scope");

  // THE REFRESH BUTTON IS THE WAY BACK, because `gh auth refresh -s read:project`
  // is a thing somebody does and then presses refresh.
  await store.github.list("project_one", { force: true });
  expect(seen.filter(isBoardCall)).toHaveLength(4);
});

// Board calls are recorded as `board`: they share `pr view` with the detail read and would count double.
function forgeStore(pull: () => Record<string, unknown>) {
  const calls: string[] = [];
  let clock = 1_000;
  const store = new EngineStore(root(), () => clock, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      calls.push(isBoardCall(args) ? "board" : args.slice(0, 2).join(" "));
      if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      if (isBoardCall(args)) return { status: 0, stdout: args[1] === "list" ? "[]" : "{}", stderr: "" };
      if (args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[1] === "merge") return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: JSON.stringify(pull()), stderr: "" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });
  return { store, calls, tick: (ms: number) => (clock += ms) };
}

const OPEN_PULL = {
  number: 12,
  title: "Ship it",
  state: "OPEN",
  isDraft: false,
  url: "u",
  createdAt: "2026-08-01T00:00:00Z",
  baseRefName: "main",
  headRefName: "telar/x",
  headRefOid: "head-1",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
};

test("a detail read has its OWN cache, so reopening a tab does not re-read the list", async () => {
  // Folding this into the snapshot cache would mean a list refresh could answer a
  // detail read with rows that have no body, and reopening one issue would spend
  // three API calls re-reading every issue.
  const { store, calls, tick } = forgeStore(() => OPEN_PULL);
  // Counted by the pull-request read alone: `readPull` also asks the repository
  // which merge methods it allows, concurrently, and that call is not the subject
  // of this test.
  const views = () => calls.filter((call) => call === "pr view").length;
  await store.github.pull("project_one", 12);
  expect(views()).toBe(1);
  await store.github.pull("project_one", 12);
  expect(views()).toBe(1);

  // A different number is a different read.
  await store.github.pull("project_one", 13);
  expect(views()).toBe(2);
  // And the refresh button still gets through, as does time.
  await store.github.pull("project_one", 12, { force: true });
  tick(31_000);
  await store.github.pull("project_one", 12);
  expect(views()).toBe(4);
});

test("a FAILED detail read is not cached — the fix takes less than thirty seconds", async () => {
  // Caching "gh is not signed in" would tell somebody who just ran `gh auth
  // login` that their fix did not work.
  let signedIn = false;
  const calls: string[] = [];
  const store = new EngineStore(root(), () => 1_000, {
    git: () => ({ status: 0, stdout: "", stderr: "" }),
    gh: async (_cwd, args) => {
      // The board half and the thread half are not the subject: both are separate
      // calls by design, and both fail without failing the detail read.
      if (!isBoardCall(args) && !isThreadCall(args)) calls.push(args[1] ?? "");
      return signedIn
        ? { status: 0, stdout: JSON.stringify({ number: 4, title: "t", state: "OPEN", url: "u" }), stderr: "" }
        : { status: 1, stdout: "", stderr: "gh auth login" };
    },
  });
  store.projectRegistry.register({ id: "project_one", name: "One", root: fs.realpathSync.native(root()) });

  expect(await store.github.issue("project_one", 4)).toEqual({ unavailable: "not_authenticated" });
  signedIn = true;
  expect(await store.github.issue("project_one", 4)).toMatchObject({ issue: { number: 4 } });
  expect(calls).toHaveLength(2);
});

test("a merge DROPS both caches, so the panel that merged it does not go on saying open", async () => {
  // The worst possible moment for a thirty-second cache to be right about a
  // stale answer.
  let state = "OPEN";
  const { store, calls } = forgeStore(() => ({ ...OPEN_PULL, state, ...(state === "MERGED" ? { mergedAt: "2026-08-04T00:00:00Z" } : {}) }));
  await store.github.list("project_one");
  await store.github.pull("project_one", 12);
  calls.length = 0;

  const result = await store.github.merge("project_one", 12, { method: "squash", expectedHeadOid: "head-1" });
  state = "MERGED";
  expect(result.merged).toBe(true);

  // The merge's own confirming read is fresher than any cache, so it BECOMES the
  // cached answer rather than being thrown away.
  await store.github.pull("project_one", 12);
  expect(calls.filter((call) => call === "pr view")).toHaveLength(2);
  // And the list is re-read, because the row this merge closed is in it.
  await store.github.list("project_one");
  expect(calls).toContain("issue list");
});

test("a merge with no head to pin against is refused before gh is reached", async () => {
  // There is deliberately no "merge whatever is there now" path.
  const { store, calls } = forgeStore(() => OPEN_PULL);
  await expect(store.github.merge("project_one", 12, { method: "merge", expectedHeadOid: "  " })).rejects.toThrow(EngineStateError);
  await expect(store.github.merge("project_one", 0, { method: "merge", expectedHeadOid: "head-1" })).rejects.toThrow(EngineStateError);
  await expect(store.github.issue("project_one", 1.5)).rejects.toThrow(EngineStateError);
  expect(calls).toEqual([]);
});
