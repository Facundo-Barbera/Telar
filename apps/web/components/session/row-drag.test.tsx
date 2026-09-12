/**
 * DRAG TO REORDER A CONVERSATION — issue #279, the rail half.
 *
 * WHAT A RENDER CAN PROVE HERE, and it is the one thing that matters: the drag
 * handle and the right-click trigger are DIFFERENT ELEMENTS. A platform drag
 * and a base-ui context menu on one node compete for the same press — the
 * project header avoids it by putting the trigger inside the draggable button,
 * the Spool's board card by putting the trigger inside the draggable `<li>`,
 * and this row by wrapping the menu in a handle of its own. The rest of the
 * gesture — where a drop lands, which band it is confined to — is arithmetic,
 * and `lib/session-groups.test.ts` pins it as arithmetic.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/** The row asks the app router for a `push` it only ever calls from a menu.
 *  Stubbed rather than provided: mounting Next's router to assert a `draggable`
 *  attribute would be a whole framework standing in for one string. */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/components/ui/sidebar");
import type { SidebarSession } from "@/lib/session-list";

const session: SidebarSession = {
  id: "s1",
  title: "A conversation",
  projectId: "p1",
  projectName: "Telar",
  activity: "idle",
  createdAt: 1,
  updatedAt: 1,
  archived: false,
  driver: "claude",
  workspacePath: "/repo",
};

const noop = () => {};
const drag = {
  dragging: false,
  insert: null,
  onDragStart: noop,
  onDragEnd: noop,
  onDragOver: noop,
  onDragLeave: noop,
  onDrop: noop,
} as const;

const render = (over: Partial<React.ComponentProps<typeof SessionRow>> = {}) =>
  renderToStaticMarkup(
    <SidebarProvider>
      <SessionRow session={session} active={false} showProject={false} variant="card" band="active" renderedAt={0} onRefresh={noop} {...over} />
    </SidebarProvider>,
  );

describe("a row in an arrangeable band is a drag handle", () => {
  test("the row carries `draggable`", () => {
    expect(render({ drag })).toContain('draggable="true"');
  });

  test("a row in a band that does not arrange carries none", () => {
    // Search results, the shelves and "Needs you" pass no `drag` — a list that
    // is an answer, a shelf you are not keeping and a queue the engine fills
    // are none of them places where a position means anything. (The row's own
    // anchor still says `draggable="false"`; that is the link declining to
    // drag its URL, not the row offering to move.)
    expect(render()).not.toContain('draggable="true"');
  });

  test("the handle WRAPS the right-click trigger rather than being it", () => {
    // #286 wraps the row in a ContextMenuTrigger. That trigger renders
    // `display: contents` — never an event target itself, so the press lands on
    // the row inside it. `draggable` on that same node would put a grab and a
    // right-press on one element; the handle is the box around it instead.
    const html = render({ drag });
    const handle = html.indexOf("draggable");
    const trigger = html.indexOf('data-slot="context-menu-trigger"');
    expect(handle).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(handle);
    const tag = html.slice(trigger, html.indexOf(">", trigger));
    expect(tag).not.toContain("draggable");
  });

  test("the row's link does not drag its own URL out from under the handle", () => {
    // An <a href> is draggable by default; left alone, a grab on the title
    // would hand the platform a URL instead of moving the row.
    const html = render({ drag });
    const anchor = html.indexOf("<a ");
    expect(anchor).toBeGreaterThan(0);
    expect(html.slice(anchor, html.indexOf(">", anchor))).toContain('draggable="false"');
  });

  test("the insert mark is a shadow, so drag-over does not change the row's height", () => {
    // The lobby bug this app already fixed once: a border added on drag-over
    // grows the box on the frame it appears and shoves every row under the
    // pointer. An inset shadow draws the same 2px line and changes no box.
    const above = render({ drag: { ...drag, insert: "above" } });
    const below = render({ drag: { ...drag, insert: "below" } });
    expect(above).toContain("shadow-[inset_0_2px_0_0_var(--color-sidebar-primary)]");
    expect(below).toContain("shadow-[inset_0_-2px_0_0_var(--color-sidebar-primary)]");
    for (const html of [above, below]) expect(html).not.toContain("border-t-2");
  });
});
