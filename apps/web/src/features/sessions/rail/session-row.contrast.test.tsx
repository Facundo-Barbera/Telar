/**
 * AN UNPINNED ROW'S TITLE IS AT FULL INK.
 *
 * Every row inside a project group is drawn slim, and the slim volume used to
 * paint its title at `text-sidebar-foreground/70` whatever its band — so every
 * unpinned conversation read greyed out beside the pinned cards. Only a shelved
 * row (settled or snoozed) recedes now.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/components/ui/sidebar");
import type { SessionBand, SidebarSession } from "../session-list";

const slim = (band: SessionBand) =>
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
          } as SidebarSession
        }
        active={false}
        showProject={false}
        variant="slim"
        band={band}
        renderedAt={10}
        onRowChanged={() => {}}
      />
    </SidebarProvider>,
  );

describe("slim row contrast", () => {
  test("an unpinned row in a project group is not dimmed", () => {
    const html = slim("active");
    expect(html).not.toContain("text-sidebar-foreground/70");
    expect(html).not.toContain("grayscale");
  });

  test("a shelved row still recedes", () => {
    for (const band of ["settled", "snoozed"] as const) {
      expect(slim(band)).toContain("text-sidebar-foreground/70");
      expect(slim(band)).toContain("grayscale");
    }
  });
});
