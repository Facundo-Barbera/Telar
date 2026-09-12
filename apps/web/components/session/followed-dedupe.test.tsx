/**
 * FOLLOWING STOPS DUPLICATING ROWS — issue #278, second half, end to end.
 *
 * `lib/session-groups.test.ts` pins the RULE as set math. This file pins the two
 * things the rule cannot prove about itself: that the set the rail withholds is
 * the same set the "Following" block draws, and that the group says so with a
 * chip whose rows come back when you ask for them.
 *
 * THE SHARED RESOLUTION IS THE WHOLE POINT. `followedSessions` is exported so
 * `app-sidebar.tsx` and `RelatedWork` ask one question once — a rail that
 * computed "followed" a second way would hide a row in one place and show it in
 * the other the moment the two spellings drifted, which is the bug wearing a
 * different hat.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { followedSessions, RelatedWork } from "./related-work";
import { ProjectGroupSection } from "./project-group";
import { SidebarProvider } from "@/components/ui/sidebar";
import { groupSessions, withholdFollowedRows, type ProjectGroup } from "@/lib/session-groups";
import { relatedWork, sessionKey, type SidebarSession } from "@/lib/session-list";

const dir = fileURLToPath(new URL(".", import.meta.url));

const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "p1", projectName: "Telar", activity: "idle", createdAt: 1, ...extra }) as SidebarSession;

const subscription = (id: string, target: string, from = "coord") =>
  ({ id, subscriberSessionId: from, targetSessionId: target, events: ["turn_completed"], createdAt: 1 }) as never;

/** `SessionRow` reads `useSidebar`, so an opened group needs the provider. */
const renderGroup = (group: ProjectGroup, open = true) =>
  renderToStaticMarkup(
    <SidebarProvider>
    <ProjectGroupSection
      group={group}
      open={open}
      onToggle={() => {}}
      onNavigate={() => {}}
      renderedAt={0}
      bandFor={() => "active"}
      onRefresh={() => {}}
      dragging={false}
      insert={null}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      onDragOver={() => {}}
      onDragLeave={() => {}}
      onDrop={() => {}}
      onNewConversation={() => {}}
      onCollapseOthers={() => {}}
    />
    </SidebarProvider>,
  );

describe("one resolution, two callers", () => {
  test("what `followedSessions` answers is exactly what the Following block draws", () => {
    const watched = session("watched", { title: "Watched" });
    const stranger = session("other", { title: "Other" });
    const following = [subscription("sub_1", "watched")];

    const resolved = followedSessions(following, [watched, stranger], undefined);
    expect(resolved.map(({ session: s }) => sessionKey(s))).toEqual(["watched"]);

    const html = renderToStaticMarkup(
      <RelatedWork groups={relatedWork([], { id: "coord" })} coordinatorId="coord" following={following} followed={[watched, stranger]} />,
    );
    expect(html).toContain("Watched");
    expect(html).not.toContain("Other");
  });

  test("two subscriptions to one target are ONE claim, not two", () => {
    // A `once` beside a standing one. The row is withheld once; a second claim
    // would make the chip say "+2" for a single conversation.
    const watched = session("watched");
    const resolved = followedSessions([subscription("sub_1", "watched"), subscription("sub_2", "watched")], [watched], undefined);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.subscriptionIds).toEqual(["sub_1", "sub_2"]);
  });

  test("HOST-QUALIFIED: a same-id row from another Mac is never claimed", () => {
    const foreign = session("watched", { hostId: "other-mac" });
    expect(followedSessions([subscription("sub_1", "watched")], [foreign], undefined)).toEqual([]);
    // …and the coordinator on that Mac claims it, which is the same comparison.
    expect(followedSessions([subscription("sub_1", "watched")], [foreign], "other-mac")).toHaveLength(1);
  });
});

describe("the rail, wired", () => {
  /** The rail's own pipeline: group the page, then apply the rule to it. */
  const rail = (pinned: SidebarSession[], sessions: SidebarSession[], following: Record<string, string[]>) => {
    const grouped = groupSessions({ pinned, sessions });
    const pool = [...pinned, ...sessions];
    return withholdFollowedRows(
      grouped.groups,
      grouped.pinned.map((coordinator) => ({
        key: sessionKey(coordinator),
        title: coordinator.title,
        following: followedSessions(
          (following[coordinator.id] ?? []).map((target, index) => subscription(`sub_${coordinator.id}_${index}`, target, coordinator.id)),
          pool,
          coordinator.hostId,
        ).map(({ session: s }) => sessionKey(s)),
      })),
    );
  };

  const coordinator = (id: string, title: string) => session(id, { title, settledOverride: "active" });

  test("a followed session is drawn under Following and NOT in its project group", () => {
    const groups = rail([coordinator("coord", "Coordinator")], [session("worker"), session("plain")], { coord: ["worker"] });
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["plain"]);
    expect(groups[0]?.withheld?.[0]?.sessions.map((s) => s.id)).toEqual(["worker"]);
  });

  test("TWO PINNED COORDINATORS FOLLOWING THREE SESSIONS — the acceptance case", () => {
    // The issue's own scenario. Each row lands under exactly one coordinator,
    // the shared one under the FIRST, and the group draws none of them.
    const groups = rail(
      [coordinator("coord_a", "Coordinator A"), coordinator("coord_b", "Coordinator B")],
      [session("w1"), session("w2"), session("w3"), session("untouched")],
      { coord_a: ["w1", "w2"], coord_b: ["w2", "w3"] },
    );
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["untouched"]);
    expect(groups[0]?.withheld?.map((w) => [w.coordinatorTitle, w.sessions.map((s) => s.id)])).toEqual([
      ["Coordinator A", ["w1", "w2"]],
      // w2 is A's; B keeps only what nobody claimed before it.
      ["Coordinator B", ["w3"]],
    ]);
  });

  test("unpinning the coordinator gives the rows back to their project", () => {
    // The rule is scoped to "while that coordinator is pinned" — nothing about
    // it is persisted, so this is simply the same derivation with no pinned row.
    const groups = rail([], [session("worker"), session("plain")], { coord: ["worker"] });
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["worker", "plain"]);
    expect(groups[0]?.withheld).toBeUndefined();
  });
});

/**
 * NO `SessionRow` IN THESE RENDERS, AND THAT IS THE FIXTURE DOING ITS JOB. A row
 * reaches for the Next app router, which a server render has no mount for — the
 * same reason `context-menus.test.tsx` renders its group folded. Here the group
 * opens with NO drawn sessions of its own and the chips collapsed, which is
 * exactly the state under test: the chip is drawn, its rows are not.
 */
describe("the group's chip", () => {
  const withChip = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({
    key: "p1",
    projectId: "p1",
    name: "Telar",
    sessions: [],
    withheld: [
      {
        coordinatorKey: "coord",
        coordinatorTitle: "Coordinator A",
        sessions: [session("w1", { title: "Worker one" }), session("w2", { title: "Worker two" })],
      },
    ],
    ...over,
  });

  test('says "+N following <coordinator>" and names what clicking it does', () => {
    const html = renderGroup(withChip());
    expect(html).toContain("+2");
    expect(html).toContain("following Coordinator A");
    expect(html).toContain("Show the 2 following Coordinator A");
  });

  test("the withheld rows are NOT drawn until the chip is opened", () => {
    // Collapsed by default: the chip is a reveal, and drawing the rows under it
    // unasked would be the duplicate row this whole rule removes.
    const html = renderGroup(withChip());
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Worker one");
    expect(html).not.toContain("Worker two");
  });

  test("a folded group still says how many it is holding back", () => {
    // The chips live in the body, so the header count is all a folded group says.
    expect(renderGroup(withChip({ sessions: [session("plain")] }), false)).toContain("1 shown, 2 under Following");
    // …and the drawn count alone when nothing is withheld.
    const plain = renderGroup(withChip({ sessions: [session("plain")], withheld: undefined }), false);
    expect(plain).toContain("1 shown");
    expect(plain).not.toContain("under Following");
  });

  test("a group with nothing withheld grows no chip at all", () => {
    expect(renderGroup(withChip({ withheld: undefined }))).not.toContain("following");
  });

  test("two coordinators are two chips, each naming its own", () => {
    const html = renderGroup(
      withChip({
        withheld: [
          { coordinatorKey: "a", coordinatorTitle: "Coordinator A", sessions: [session("w1")] },
          { coordinatorKey: "b", coordinatorTitle: "Coordinator B", sessions: [session("w2")] },
        ],
      }),
    );
    expect(html).toContain("following Coordinator A");
    expect(html).toContain("following Coordinator B");
    // A shared drawer would lose which rows were whose.
    expect(html.indexOf("Coordinator A")).toBeLessThan(html.indexOf("Coordinator B"));
  });

  test("each chip owns its own rows — the reveal is per coordinator, not per group", () => {
    // Un-renderable here (opening one is a click, and these tests are a server
    // render), so it is pinned where it is decidable: the rows are nested inside
    // the same element as the chip that reveals them, keyed by that coordinator.
    const source = fs.readFileSync(path.join(dir, "project-group.tsx"), "utf8");
    const block = source.slice(source.indexOf("{withheld.map((entry)"), source.indexOf("{group.sessions.map("));
    expect(block).toContain("const open = expanded.has(entry.coordinatorKey);");
    // Whitespace-insensitive: a formatter run must not fail this.
    expect(block).toMatch(/\{open\s*&&\s*entry\.sessions\.map\(/);
  });
});
