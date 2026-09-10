// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RelatedWork } from "./related-work";
import { relatedWork, type SidebarSession } from "@/lib/session-list";

/**
 * The three relationships, rendered — and kept apart, because merging them is
 * the failure this surface exists to prevent: an assignment ENDS, provenance
 * does not, and following is neither.
 */
const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "project_one", ...extra }) as SidebarSession;

const assignment = (from: string, extra: Record<string, unknown> = {}) =>
  ({ taskRunId: `task_${from}`, fromSessionId: from, receivedAt: 1, runId: `task_${from}`, ...extra }) as never;

test("outstanding work is separated from work awaiting review", () => {
  const sessions = [
    session("worker_a", { assignments: [assignment("coord", { scope: "engine only" })] }),
    session("worker_b", { assignments: [assignment("coord", { outcome: "completed", endedAt: 9 })] }),
  ];
  const groups = relatedWork(sessions, { id: "coord" });
  const html = renderToStaticMarkup(<RelatedWork groups={groups} coordinatorId="coord" />);

  expect(html).toContain("Working on behalf of");
  expect(html).toContain("Awaiting review");
  // The scope the coordinator named rides the active row.
  expect(html).toContain("engine only");
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
  expect(renderToStaticMarkup(<RelatedWork groups={groups} coordinatorId="coord" />)).toContain("Started from here");
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

test("FOLLOWING renders as its own group and is not an assignment", () => {
  const groups = relatedWork([], { id: "coord" });
  const html = renderToStaticMarkup(
    <RelatedWork
      groups={groups}
      coordinatorId="coord"
      following={[{ id: "sub_1", subscriberSessionId: "coord", targetSessionId: "watched", events: ["turn_completed"], createdAt: 1 }]}
      followed={[session("watched", { title: "Watched" })]}
    />,
  );
  expect(html).toContain("Following");
  expect(html).toContain("Watched");
  expect(html).not.toContain("Working on behalf of");
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
