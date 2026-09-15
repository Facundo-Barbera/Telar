/**
 * A ROW WHOSE CHECKOUT IS NOT THERE YET — issue #496.
 *
 * `git worktree add` used to run inside `POST /v2/sessions` and hold the
 * daemon's event loop for its whole duration. It runs in the background now, so
 * a worktree session exists for a few seconds before the directory it works in
 * does, and the rail is where a person watches the session they just opened.
 *
 * RENDERED RATHER THAN ASSERTED ON A HELPER, for `project-group.rows.test.tsx`'s
 * reason: what this is about is which of several competing statuses actually
 * reaches the markup, and a precedence chain can only be read off the output.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/** A drawn row asks the app router for a `push` it only calls from a menu. */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/components/ui/sidebar");
import type { SidebarSession } from "@/lib/session-list";

const row = (over: Partial<SidebarSession>) =>
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
            workspacePath: "/tmp/wt",
            ...over,
          } as SidebarSession
        }
        active={false}
        showProject={false}
        renderedAt={10}
        onRefresh={() => {}}
      />
    </SidebarProvider>,
  );

describe("the preparing and failed states on the rail row", () => {
  test("says it is preparing, and spins while it is", () => {
    // The motion is the fastest read in the list — you see that something is
    // happening before you read which row it is.
    const html = row({ preparation: { state: "preparing", at: 1 } });
    expect(html).toContain("Preparing");
    expect(html).toContain("animate-spin");
  });

  test("shows git's own first line when the cut failed, and keeps the rest in the title", () => {
    // NOT A WORD OF OURS. "Setup failed" would tell a reader only that they are
    // stuck; git's sentence tells them what to do about it.
    const html = row({
      preparation: {
        state: "failed",
        at: 1,
        error: "fatal: Unable to create '.git/index.lock': File exists\nAnother git process seems to be running",
      },
    });
    expect(html).toContain("index.lock");
    // The rest rides in `title`, because the slot is one line and git's is not.
    expect(html).toContain("Another git process seems to be running");
    // Amber by the vocabulary's own rule: a person has to move.
    expect(html).toContain("text-warning");
  });

  test("a failure with no stderr still says what happened", () => {
    expect(row({ preparation: { state: "failed", at: 1 } })).toContain("Worktree setup failed");
  });

  test("outranks the activity badge, because nothing runs in a checkout that is not there", () => {
    // The engine agrees by construction: `claimTurn` holds a turn while a
    // session has no checkout, so a `working` badge here would be a lie.
    const html = row({ activity: "working", preparation: { state: "preparing", at: 1 } });
    expect(html).toContain("Preparing");
    expect(html).not.toContain("Working");
  });

  test("a ready session is untouched — absent means ready", () => {
    expect(row({ activity: "working" })).toContain("Working");
  });
});
