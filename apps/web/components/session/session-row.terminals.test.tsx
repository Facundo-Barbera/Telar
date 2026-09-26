/**
 * WHAT A ROW SAYS ABOUT ITS TERMINALS — issue #883.
 *
 * A settled row still holding terminals wears a count, explained on hover, and
 * its hover actions carry the way to close them. An active row's Settle says
 * how many it will close, and nothing more when there are none. Every case
 * starts from a `LiveSessionRow` parsed by the protocol and a count taken off
 * the live read's `terminals` map, through `toSidebarSession`, as the rail does.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveSessionRow } from "@telar/engine-client";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { toSidebarSession } = await import("@/lib/session-list");

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const liveRow = (over: Record<string, unknown> = {}) =>
  LiveSessionRow.parse({
    id: "session_1",
    title: "Exoplanets",
    state: "active",
    createdAt: NOW - 3 * 60 * MINUTE,
    updatedAt: NOW - 3 * 60 * MINUTE,
    driver: "claude",
    workspace: { mode: "local", path: "/tmp/exoplanets" },
    envMode: "local",
    activity: "idle",
    ...over,
  });

/** The live read's `terminals` map, as the rail reads it. */
const row = (over: Record<string, unknown>, terminals: Record<string, number>, { band }: { band?: "settled" } = {}) =>
  renderToStaticMarkup(
    <SidebarProvider>
      <SessionRow
        session={toSidebarSession(liveRow(over), "exoplanets", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, terminals["session_1"])}
        active={false}
        showProject={false}
        variant={band === "settled" ? "slim" : "card"}
        {...(band ? { band } : {})}
        renderedAt={NOW}
        onRowChanged={() => {}}
      />
    </SidebarProvider>,
  );

const settled = { settledOverride: "settled", settledAt: NOW - 10 * MINUTE };

describe("a settled row still running something", () => {
  test("wears the count, explains it on hover, and offers to close them", () => {
    const html = row(settled, { session_1: 2 }, { band: "settled" });
    expect(html).toContain('title="2 terminals still open in this settled conversation, shells you opened included"');
    expect(html).toContain('aria-label="Close its 2 terminals"');
  });

  test("with none, it wears nothing and offers nothing", () => {
    const html = row(settled, {}, { band: "settled" });
    expect(html).not.toContain("still open in this settled conversation");
    expect(html).not.toContain("Close its");
  });

  test("an active row's terminals are its work: no count on it", () => {
    const html = row({}, { session_1: 2 });
    expect(html).not.toContain("still open in this settled conversation");
    expect(html).not.toContain("Close its");
  });

  test("when Telar closed them, the row's hover says why", () => {
    const html = row({ ...settled, terminalsClosed: { at: NOW - MINUTE, terminals: 3, reason: "limit" } }, {}, { band: "settled" });
    expect(html).toContain("Telar closed its 3 terminals");
  });
});

describe("Settle says what it will close before the press", () => {
  test("closes N terminals", () => {
    expect(row({}, { session_1: 2 })).toContain('title="Settle — closes 2 terminals"');
    expect(row({}, { session_1: 1 })).toContain('title="Settle — closes 1 terminal"');
  });

  test("and nothing extra at zero", () => {
    const html = row({}, {});
    expect(html).toContain('title="Settle"');
    expect(html).not.toContain("closes");
  });
});
