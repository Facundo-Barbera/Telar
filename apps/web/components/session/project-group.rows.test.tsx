/**
 * A DELEGATED CONVERSATION IS A SIBLING, NOT A CHILD — issue #381.
 *
 * The owner's complaint, verbatim: "It makes it feel like sub-agents when they
 * are really separate conversations." The rail drew a session somebody had
 * handed work to as an indented row behind an elbow (#324), under the row that
 * handed it over — a shape that says "this belongs to that", which is exactly
 * what a separate conversation with its own worktree and its own life does not.
 *
 * So the group draws what it holds, in the order it holds it, at one level. The
 * relationship itself is not lost: it is stated on the panel's Agents surface,
 * where a row has room to say what the errand was and how it went (see
 * `related-conversations.tsx`).
 *
 * RENDERED RATHER THAN SCANNED. `sidebar-bands.test.ts` reads the rail's source
 * for the call sites that no longer exist; this asks the question a reader
 * asks — is the delegate on the same rail as everything else — of actual
 * markup, which is the only place an indent could still hide.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/** A drawn row asks the app router for a `push` it only calls from a menu.
 *  Stubbed for the reason `row-drag.test.tsx` gives: mounting Next's router to
 *  read an `href` would be a framework standing in for a string. */
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
  ({ id, title: id, projectId: "p1", projectName: "Telar", activity: "idle", createdAt: 1, ...extra }) as SidebarSession;

const assignment = (from: string, extra: Record<string, unknown> = {}) =>
  ({ taskRunId: `task_${from}`, fromSessionId: from, receivedAt: 1, runId: `task_${from}`, ...extra }) as never;

/** The group OPEN, which is the only state that draws rows at all. */
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
        onNewConversation={() => {}}
        onCollapseOthers={() => {}}
      />
    </SidebarProvider>,
  );
}

test("an outstanding delegate draws beside the conversation that delegated to it", () => {
  const html = renderGroup([
    session("coord", { title: "Coordinator" }),
    session("worker", { title: "Worker", assignments: [assignment("coord", { scope: "engine only" })] }),
  ]);

  // Both are rows of this group, each linking to itself.
  expect(html).toContain('href="/projects/p1/sessions/coord"');
  expect(html).toContain('href="/projects/p1/sessions/worker"');
  // lucide renders its name as a class, which is the stable handle a static
  // render gives us on the elbow that used to carry the indent.
  expect(html).not.toContain("lucide-corner-down-right");
  // The block the child rows lived in, named to a screen reader.
  expect(html).not.toContain('aria-label="Related work"');
  // The scope was the hint on an indented row. Nothing states an errand here.
  expect(html).not.toContain("engine only");
});

test("provenance and a finished errand are rows too — no relationship indents anything", () => {
  const html = renderGroup([
    session("coord", { title: "Coordinator" }),
    session("done", { title: "Done", assignments: [assignment("coord", { outcome: "completed", endedAt: 9 })] }),
    session("free", { title: "Free", startedFrom: { sessionId: "coord" } }),
  ]);
  for (const id of ["coord", "done", "free"]) expect(html).toContain(`href="/projects/p1/sessions/${id}"`);
  expect(html).not.toContain("lucide-corner-down-right");
  expect(html).not.toContain("finished");
});

test('a group\'s count is its rows, and no "+N following" chip holds any back', () => {
  const html = renderGroup([session("a"), session("b"), session("c")]);
  expect(html).toContain('aria-label="3 shown"');
  expect(html).not.toContain("following");
});
