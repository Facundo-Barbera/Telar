/**
 * The flat rail, rendered: children fold behind their parent's summary line,
 * and the one that needs the person is drawn anyway.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { FlatSessionList, RailModeSwitch } = await import("./flat-session-list");
const { SidebarProvider } = await import("@/ui/sidebar");
import { flattenSessions } from "./flat-rail";
import type { SidebarSession } from "../session-list";

const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: `title-${id}`, projectId: "p1", projectName: "Telar", activity: "idle", createdAt: 1, updatedAt: 1, ...extra }) as SidebarSession;

function render(expanded: Set<string>): string {
  const entries = flattenSessions({
    pinned: [],
    sessions: [
      session("parent"),
      session("busy", { startedFrom: { sessionId: "parent" }, activity: "working" }),
      session("stuck", { startedFrom: { sessionId: "parent" }, activity: "blocked" }),
    ],
  });
  return renderToStaticMarkup(
    <SidebarProvider>
      <FlatSessionList
        entries={entries}
        expanded={expanded}
        onToggle={() => {}}
        renderedAt={0}
        bandFor={() => "active"}
        onRowChanged={() => {}}
        jumpSlot={() => undefined}
      />
    </SidebarProvider>,
  );
}

test("collapsed: the summary line, and only the child that needs the person", () => {
  const html = render(new Set());
  expect(html).toContain("2 sessions · 1 working · 1 needs you");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("title-stuck");
  expect(html).not.toContain("title-busy");
  // The project rides on the parent's card.
  expect(html).toContain("Telar");
});

test("expanded: every child under the parent", () => {
  const html = render(new Set(["parent"]));
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("title-busy");
  expect(html).toContain("title-stuck");
});

test("the mode switch marks the current choice", () => {
  const html = renderToStaticMarkup(<RailModeSwitch mode="flat" onChange={() => {}} />);
  expect(html).toContain("Group by");
  expect(html).toMatch(/aria-pressed="true"[^>]*>None</);
  expect(html).toMatch(/aria-pressed="false"[^>]*>Project</);
});
