/**
 * NO COLOURED BAR ON THE RAIL ROW'S LEFT EDGE. The badge says working or
 * waiting; the tint says selected. Rendered, because the stripe was a class
 * string on the row's wrapper and only the markup shows whether it came back.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/ui/sidebar");
import type { SidebarSession } from "../session-list";

const row = (over: Partial<SidebarSession>, active = false) =>
  renderToStaticMarkup(
    <SidebarProvider>
      <SessionRow
        session={
          {
            id: "session_1",
            title: "Exoplanets",
            createdAt: 1,
            updatedAt: 2,
            driver: "claude",
            projectName: "exoplanets",
            activity: "idle",
            ...over,
          } as SidebarSession
        }
        active={active}
        showProject={false}
        renderedAt={10}
        onRowChanged={() => {}}
      />
    </SidebarProvider>,
  );

describe("the rail row's leading edge", () => {
  for (const activity of ["working", "waiting", "idle"] as const) {
    for (const active of [true, false]) {
      test(`${activity}, ${active ? "selected" : "not selected"}: no stripe`, () => {
        const html = row({ activity }, active);
        expect(html).not.toContain("before:left-0");
        expect(html).not.toContain("before:bg-primary");
        expect(html).not.toContain("before:bg-warning");
      });
    }
  }

  test("the selected row is still the tinted one", () => {
    expect(row({ activity: "working" }, true)).toContain("bg-sidebar-accent");
  });
});
