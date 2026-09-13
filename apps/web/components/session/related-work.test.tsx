// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RelatedWork, relatedTree } from "./related-work";
import { relatedWork, sessionKey, type SidebarSession } from "@/lib/session-list";

/**
 * The three relationships, rendered — and kept apart, because merging them is
 * the failure this surface exists to prevent: an assignment ENDS, provenance
 * does not, and following is neither.
 *
 * THEY ARE KEPT APART IN THE SORT, NOT IN CAPTIONS — issue #323. Every related
 * session is now one indented child row behind an elbow, so what these tests
 * read for is the row, its trailing state hint and its order, never a heading.
 */
const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "project_one", ...extra }) as SidebarSession;

const assignment = (from: string, extra: Record<string, unknown> = {}) =>
  ({ taskRunId: `task_${from}`, fromSessionId: from, receivedAt: 1, runId: `task_${from}`, ...extra }) as never;

test("outstanding work is separated from work awaiting review — by state, not by caption", () => {
  const sessions = [
    session("worker_a", { assignments: [assignment("coord", { scope: "engine only" })] }),
    session("worker_b", { assignments: [assignment("coord", { outcome: "completed", endedAt: 9 })] }),
  ];
  const groups = relatedWork(sessions, { id: "coord" });
  const html = renderToStaticMarkup(<RelatedWork groups={groups} coordinatorId="coord" />);

  // The scope the coordinator named rides the active row, and says "working" by
  // saying which work; the finished one says so in its own hint.
  expect(html).toContain("engine only");
  expect(html).toContain("finished");
  // The headings are gone: they sat between a coordinator and the row it owned.
  expect(html).not.toContain("Working on behalf of");
  expect(html).not.toContain("Awaiting review");
  // Outstanding still sorts above finished — the relationships differ.
  expect(html.indexOf("worker_a")).toBeLessThan(html.indexOf("worker_b"));
});

test("an outstanding assignment with NO scope still says what it is doing", () => {
  const sessions = [session("worker", { assignments: [assignment("coord")] })];
  const html = renderToStaticMarkup(<RelatedWork groups={relatedWork(sessions, { id: "coord" })} coordinatorId="coord" />);
  expect(html).toContain("working");
});

test("EVERY related row wears the elbow, and none wears the bell", () => {
  // The glyph is the whole message: "this comes from the row above". The bell
  // was a state icon in the one place where the state could not differ.
  const sessions = [
    session("worker", { assignments: [assignment("coord")] }),
    session("free", { startedFrom: { sessionId: "coord" } }),
  ];
  const html = renderToStaticMarkup(
    <RelatedWork
      groups={relatedWork(sessions, { id: "coord" })}
      coordinatorId="coord"
      following={[{ id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 }]}
      followed={[session("watched", { title: "Watched" })]}
    />,
  );
  // lucide renders its name as a class, which is the one stable handle a static
  // render gives us on which glyph was drawn.
  expect(html.split("lucide-corner-down-right").length - 1).toBe(3);
  expect(html).not.toContain("lucide-bell ");
});

test("a FINISHED assignment is still shown — it is waiting to be looked at", () => {
  const sessions = [session("worker", { assignments: [assignment("coord", { outcome: "completed", endedAt: 9 })] })];
  const groups = relatedWork(sessions, { id: "coord" });
  expect(groups.review.map((s) => s.id)).toEqual(["worker"]);
  expect(renderToStaticMarkup(<RelatedWork groups={groups} coordinatorId="coord" />)).toContain("worker");
});

test("a DETACHED assignment leaves the active group without deleting provenance", () => {
  // "Continue independently": no longer working for anyone, still started here.
  const sessions = [
    session("worker", {
      assignments: [assignment("coord", { outcome: "detached", endedAt: 7 })],
      startedFrom: { sessionId: "coord" },
    }),
  ];
  const groups = relatedWork(sessions, { id: "coord" });
  expect(groups.active).toEqual([]);
  expect(groups.review).toEqual([]);
  expect(groups.independent.map((s) => s.id)).toEqual(["worker"]);
  const html = renderToStaticMarkup(<RelatedWork groups={groups} coordinatorId="coord" />);
  expect(html).toContain("worker");
  // Provenance is a fact about the edge, which the elbow now carries; the row
  // has no state to hint and says nothing about one.
  expect(html).not.toContain("Started from here");
  expect(html).not.toContain("working");
});

test("a free continuation has provenance only", () => {
  const sessions = [session("worker", { startedFrom: { sessionId: "coord" } })];
  const groups = relatedWork(sessions, { id: "coord" });
  expect(groups.independent.map((s) => s.id)).toEqual(["worker"]);
  expect(groups.active).toEqual([]);
});

test("HOST COLLISIONS do not gather a stranger", () => {
  // Two Macs can mint the same session id; an assignment's `fromSessionId` is a
  // bare id and only means anything within one engine.
  const sessions = [
    session("worker", { assignments: [assignment("coord")] }),
    session("worker", { hostId: "other-mac", assignments: [assignment("coord")] }),
  ];
  expect(relatedWork(sessions, { id: "coord" }).active).toHaveLength(1);
  expect(relatedWork(sessions, { id: "coord", hostId: "other-mac" }).active).toHaveLength(1);
});

test("a coordinator never lists itself", () => {
  const sessions = [session("coord", { assignments: [assignment("coord")] })];
  expect(relatedWork(sessions, { id: "coord" }).active).toEqual([]);
});

test("A FOLLOWED SESSION is a child row, and the caption that mislabelled it is gone", () => {
  // The #323 screenshot: "FOLLOWING" sat between a pinned coordinator and the
  // row it owned, with nothing indented, so it read as a header for the NEXT
  // pinned row instead.
  const groups = relatedWork([], { id: "coord" });
  const html = renderToStaticMarkup(
    <RelatedWork
      groups={groups}
      coordinatorId="coord"
      following={[{ id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 }]}
      followed={[session("watched", { title: "Watched" })]}
    />,
  );
  expect(html).toContain("Watched");
  expect(html).not.toContain("Following</");
  expect(html).not.toContain("Working on behalf of");
  // …and the block is still named to a screen reader without them.
  expect(html).toContain('aria-label="Related work"');
});

test("nothing related renders nothing at all", () => {
  expect(renderToStaticMarkup(<RelatedWork groups={relatedWork([], { id: "coord" })} coordinatorId="coord" />)).toBe("");
});

test("TWO COORDINATORS each get their own block, in order", () => {
  // The mount bug this pins: one map for every row followed by a second map for
  // every related block put both blocks after both rows, so a reader could not
  // tell whose delegates were whose.
  const sessions = [
    session("coord_a", { title: "Coordinator A" }),
    session("coord_b", { title: "Coordinator B" }),
    session("worker_a", { title: "Worker A", assignments: [assignment("coord_a")] }),
    session("worker_b", { title: "Worker B", assignments: [assignment("coord_b")] }),
  ];
  const html = sessions
    .filter((candidate) => candidate.id.startsWith("coord"))
    .map((coordinator) =>
      renderToStaticMarkup(
        <div>
          <span>{coordinator.title}</span>
          <RelatedWork groups={relatedWork(sessions, coordinator)} coordinatorId={coordinator.id} />
        </div>,
      ),
    )
    .join("");

  // A's block names A's worker and NOT B's, and each sits after its own row.
  const first = html.slice(html.indexOf("Coordinator A"), html.indexOf("Coordinator B"));
  expect(first).toContain("Worker A");
  expect(first).not.toContain("Worker B");
  const second = html.slice(html.indexOf("Coordinator B"));
  expect(second).toContain("Worker B");
  expect(second).not.toContain("Worker A");
});

test("an UNFOLLOW control is offered per followed row and names its subscription", () => {
  const removed: string[] = [];
  const html = renderToStaticMarkup(
    <RelatedWork
      groups={relatedWork([], { id: "coord" })}
      coordinatorId="coord"
      following={[
        { id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 },
        // A SECOND subscription to the SAME target — one row, not two.
        { id: "sub_2", subscriberSessionId: "coord", targetSessionId: "watched", events: ["request_opened"], createdAt: 2 },
      ]}
      followed={[session("watched", { title: "Watched" })]}
      onUnfollow={(_key, ids) => removed.push(...ids)}
    />,
  );
  expect(html).toContain("Stop following Watched");
  // Deduplicated: one row, one control.
  expect(html.split("Stop following Watched").length - 1).toBe(1);
  expect(removed).toEqual([]);
});

test("a followed session on ANOTHER Mac is not matched by id alone", () => {
  const html = renderToStaticMarkup(
    <RelatedWork
      groups={relatedWork([], { id: "coord" })}
      coordinatorId="coord"
      following={[{ id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 }]}
      followed={[session("watched", { title: "Foreign", hostId: "other-mac" })]}
    />,
  );
  // The coordinator is local; a same-id row from another engine is a stranger.
  expect(html).toBe("");
});

test("FOLLOW is offered on a delegate, and not on one already followed", () => {
  const worker = session("worker", { title: "Worker" });
  const followedOne = session("watched", { title: "Watched" });
  const groups = relatedWork([worker], { id: "coord" });

  // A delegate that is not followed offers the control…
  const offered = renderToStaticMarkup(
    <RelatedWork groups={relatedWork([{ ...worker, assignments: [assignment("coord")] }], { id: "coord" })} coordinatorId="coord" onFollow={() => {}} />,
  );
  expect(offered).toContain("Follow Worker");

  // …and a session already followed does not, so the two controls never both show.
  const already = renderToStaticMarkup(
    <RelatedWork
      groups={relatedWork([{ ...followedOne, assignments: [assignment("coord")] }], { id: "coord" })}
      coordinatorId="coord"
      following={[{ id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 }]}
      followed={[followedOne]}
      onFollow={() => {}}
    />,
  );
  expect(already).not.toContain("Follow Watched");
  expect(groups.active).toEqual([]);
});

test("no onFollow means no control at all", () => {
  const html = renderToStaticMarkup(
    <RelatedWork groups={relatedWork([session("worker", { assignments: [assignment("coord")] })], { id: "coord" })} coordinatorId="coord" />,
  );
  expect(html).not.toContain("Follow ");
});

/**
 * THE SAME TREE WHERE THE COORDINATOR IS NOT PINNED — issue #323.
 *
 * The pinned band has drawn its delegates underneath it since #199; a project
 * group drew the same sessions as siblings. `relatedTree` is the arrangement
 * both now share, so an indent means one thing in the rail rather than two.
 */
describe("relatedTree", () => {
  const ids = (tree: ReturnType<typeof relatedTree>) =>
    tree.rows.map(({ session: s, related }) => [
      s.id,
      [...related.active, ...related.review, ...related.independent].map((child) => child.id),
    ]);

  test("a delegate is drawn UNDER its coordinator and not beside it", () => {
    const tree = relatedTree([
      session("coord", { title: "Coord" }),
      session("worker", { assignments: [assignment("coord")] }),
      session("plain"),
    ]);
    expect(ids(tree)).toEqual([
      ["coord", ["worker"]],
      ["plain", []],
    ]);
    expect([...tree.nested]).toEqual(["worker"]);
  });

  test("provenance nests too — the elbow is the edge, whatever kind it is", () => {
    const tree = relatedTree([session("coord"), session("free", { startedFrom: { sessionId: "coord" } })]);
    expect(ids(tree)).toEqual([["coord", ["free"]]]);
  });

  test("FIRST POSITION WINS: two coordinators delegating to one session is ONE row", () => {
    // Drawing it under both would re-create the duplicate the rail's whole
    // dedupe story exists to remove.
    const shared = session("shared", { assignments: [assignment("coord_a"), assignment("coord_b")] });
    const tree = relatedTree([session("coord_a"), session("coord_b"), shared]);
    expect(ids(tree)).toEqual([
      ["coord_a", ["shared"]],
      ["coord_b", []],
    ]);
  });

  test("a row already drawn at the top is never pulled down under a later parent", () => {
    // The delegate comes FIRST in the group's arranged order, so it is a row of
    // its own by the time its coordinator is reached. Moving it then would make
    // an arrangement the reader chose reorder itself.
    const tree = relatedTree([session("worker", { assignments: [assignment("coord")] }), session("coord")]);
    expect(ids(tree)).toEqual([
      ["worker", []],
      ["coord", []],
    ]);
    expect(tree.nested.size).toBe(0);
  });

  test("ONE LEVEL, NOT A STAIRCASE: a child's own delegates stay at the top", () => {
    const tree = relatedTree([
      session("coord"),
      session("middle", { assignments: [assignment("coord")] }),
      session("leaf", { assignments: [assignment("middle")] }),
    ]);
    expect(ids(tree)).toEqual([
      ["coord", ["middle"]],
      ["leaf", []],
    ]);
  });

  test("HOST-QUALIFIED, like every other id comparison in this file", () => {
    const tree = relatedTree([
      session("coord"),
      session("worker", { hostId: "other-mac", assignments: [assignment("coord")] }),
    ]);
    // A bare `fromSessionId` from another engine is a stranger, so both are rows.
    expect(ids(tree)).toEqual([
      ["coord", []],
      ["worker", []],
    ]);
    expect(tree.rows.map(({ session: s }) => sessionKey(s))).toEqual(["coord", "other-mac:worker"]);
  });

  test("a list with no relationships in it comes back exactly as it went in", () => {
    const tree = relatedTree([session("a"), session("b")]);
    expect(ids(tree)).toEqual([
      ["a", []],
      ["b", []],
    ]);
  });
});
