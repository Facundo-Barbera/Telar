/**
 * THE RAIL SAYS THE DRIVE IS AWAY — issue #534.
 *
 * A project on an external drive is unreadable whenever the drive is elsewhere,
 * which is the ordinary state of an external drive — so what this pins is as
 * much about TONE as about text: a muted chip like the host badges beside it,
 * never a warning, and never the one piece of advice that would cost somebody
 * their project id ("re-register it"). The rows underneath still draw, because
 * their history still reads.
 *
 * RENDERED RATHER THAN SCANNED, for `project-group.rows.test.tsx`'s reason: the
 * question is what a reader sees, and markup is the only place to ask it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { ProjectGroupSection } = await import("./project-group");
const { SidebarProvider } = await import("@/components/ui/sidebar");
import { groupSessions } from "@/lib/session-groups";
import type { SidebarSession } from "@/lib/session-list";

const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "p1", projectName: "TelarVR Work", activity: "idle", createdAt: 1, ...extra }) as SidebarSession;

function renderGroup(sessions: SidebarSession[]): string {
  const group = groupSessions({ pinned: [], sessions }).groups[0]!;
  return renderToStaticMarkup(
    <SidebarProvider>
      <ProjectGroupSection
        group={group}
        open
        onToggle={() => {}}
        onNavigate={() => {}}
        renderedAt={0}
        bandFor={() => "active"}
        onRowChanged={() => {}}
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
        onNewConversation={() => {}}
        onCollapseOthers={() => {}}
      />
    </SidebarProvider>,
  );
}

test("the header says the drive is away, and the conversations under it still draw", () => {
  const html = renderGroup([
    session("one", { projectAvailability: "unmounted" }),
    session("two", { projectAvailability: "unmounted" }),
  ]);

  expect(html).toContain("drive away");
  expect(html).toContain("The drive holding TelarVR Work is not connected");
  // The rows are still rows: a project whose disk is elsewhere is not a project
  // whose conversations stopped existing.
  expect(html).toContain('href="/projects/p1/sessions/one"');
  expect(html).toContain('href="/projects/p1/sessions/two"');
});

test("it never tells anybody to re-register the project", () => {
  // That is the one piece of advice that turns a cable into a lost project id,
  // its sessions and its browser profile. The engine's refusal sentences refuse
  // to suggest it too; so does this.
  const html = renderGroup([session("one", { projectAvailability: "unmounted" })]);
  expect(html.toLowerCase()).not.toContain("re-register");
});

test("a deleted folder is a different sentence from an unplugged drive", () => {
  const html = renderGroup([session("one", { projectAvailability: "missing" })]);
  expect(html).toContain("folder gone");
  expect(html).not.toContain("drive away");
});

test("nothing is drawn when the disk is fine, or when nobody has said", () => {
  expect(renderGroup([session("one", { projectAvailability: "available" })])).not.toContain("drive away");
  expect(renderGroup([session("one")])).not.toContain("drive away");
});
