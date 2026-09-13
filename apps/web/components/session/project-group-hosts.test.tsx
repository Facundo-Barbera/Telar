/**
 * ONE REPOSITORY, TWO MACS, ONE HEADER — issue #283, the rendered half.
 *
 * `lib/session-groups.test.ts` pins the KEY as pure set math and
 * `lib/hosts/project-places.test.ts` pins the places read off the rows. Neither
 * can prove the thing a reader actually complains about: that the header names
 * both machines, and that its `+` does not silently pick one of them.
 *
 * THE LIVE CHECK IS STILL PENDING. No second Mac was reachable while this was
 * written, so the two hosts here are fixtures. What a paired Mac would add is
 * the round trip, not the rendering.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectGroupSection } from "./project-group";
import { SidebarProvider } from "@/components/ui/sidebar";
import { projectPlaces } from "@/lib/hosts/project-places";
import { groupSessions } from "@/lib/session-groups";
import type { SidebarSession } from "@/lib/session-list";

const REMOTE = "github.com/facundo-barbera/telar";

const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "p1", projectName: "Telar", activity: "idle", createdAt: 1, ...extra }) as SidebarSession;

/** The rail's own composition: rows in, one group out, its places read off it. */
function renderRail(sessions: SidebarSession[]): string {
  const group = groupSessions({ pinned: [], sessions }).groups[0]!;
  return renderToStaticMarkup(
    <SidebarProvider>
      <ProjectGroupSection
        group={group}
        open={false}
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
        rowDrag={() => ({
          dragging: false,
          insert: null,
          onDragStart: () => {},
          onDragEnd: () => {},
          onDragOver: () => {},
          onDragLeave: () => {},
          onDrop: () => {},
        })}
        places={projectPlaces(group.sessions)}
        onNewConversation={() => {}}
        onCollapseOthers={() => {}}
      />
    </SidebarProvider>,
  );
}

const bothMacs = [
  session("here", { projectId: "project_here", projectRemote: REMOTE }),
  session("there", { projectId: "project_b", hostId: "host_b", hostName: "mini", projectRemote: REMOTE }),
];

describe("a group that spans two Macs", () => {
  test("is one header wearing both Macs' badges", () => {
    const html = renderRail(bothMacs);
    expect(html).toContain("On This Mac");
    expect(html).toContain("On mini");
    // One group, one name — not the same word twice down the rail.
    expect(html.match(/>Telar</g)?.length).toBe(1);
  });

  test("its New conversation control asks which Mac instead of linking to one", () => {
    // The wrong-host mistake in one line: a `+` that quietly opened
    // `/projects/project_here/sessions/new` would start work on a machine the
    // reader never chose.
    const html = renderRail(bothMacs);
    expect(html).not.toContain("sessions/new");
    expect(html).toContain("asks which Mac");
  });

  test("one Mac's group is unchanged: no badge, and a plain link to its canvas", () => {
    const html = renderRail([session("only", { projectId: "project_here", projectRemote: REMOTE })]);
    expect(html).toContain('href="/projects/project_here/sessions/new"');
    expect(html).not.toContain("On This Mac");
  });

  test("a group that lives only on a paired Mac still links to that Mac's canvas", () => {
    const html = renderRail([
      session("only", { projectId: "project_b", hostId: "host_b", hostName: "mini", projectRemote: REMOTE }),
    ]);
    expect(html).toContain('href="/hosts/host_b/projects/project_b/sessions/new"');
    expect(html).toContain("On mini");
  });

  test("two projects with no repository to name stay two groups, however alike", () => {
    // The guard against the opposite failure: folding on the NAME would merge
    // two unrelated folders both called Telar.
    const grouped = groupSessions({
      pinned: [],
      sessions: [session("here", { projectId: "project_here" }), session("there", { projectId: "project_b", hostId: "host_b", hostName: "mini" })],
    });
    expect(grouped.groups).toHaveLength(2);
  });
});
