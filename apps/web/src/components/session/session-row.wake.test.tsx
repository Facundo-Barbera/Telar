/**
 * THE DOT THAT SAYS A CONVERSATION WOKE — issues #490, #812, #816.
 *
 * THE VALUE IS NOT SET BY HAND HERE, and that is the whole point of the file.
 * A test that builds a `SidebarSession` with `wokeAt: 123` and asserts a dot
 * appears proves the component and nothing else — the wiring it is supposed to
 * be about (engine stamp → live row → `toSidebarSession` → markup) is exactly
 * the part it steps over. So every case below starts from a `LiveSessionRow`
 * PARSED BY THE PROTOCOL SCHEMA, the same shape `/v2/sessions/live` answers,
 * and goes through `toSidebarSession` on its way to the row.
 *
 * The other half of the seam — that the engine's sweep puts the same number on
 * the row and on the `session.woke` event — is asserted against a real sweep in
 * `apps/engine/test/snooze-wake.test.ts`. Between the two there is no step where
 * a person typed the timestamp.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveSessionRow } from "@telar/engine-client";

/** A drawn row asks the app router for a `push` it only calls from a menu. */
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

/**
 * What the engine answers for one row. PARSED, never cast: a field the wire
 * stopped carrying, or one renamed, fails here rather than arriving as
 * `undefined` and drawing nothing while every assertion still passes.
 */
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

const row = (
  over: Record<string, unknown> = {},
  { variant = "card", band }: { variant?: "card" | "slim"; band?: "snoozed" } = {},
) =>
  renderToStaticMarkup(
    <SidebarProvider>
      <SessionRow
        session={toSidebarSession(liveRow(over), "exoplanets")}
        active={false}
        showProject={false}
        variant={variant}
        {...(band ? { band } : {})}
        renderedAt={NOW}
        onRowChanged={() => {}}
      />
    </SidebarProvider>,
  );

describe("a woken conversation is drawn as woken", () => {
  test("the engine's stamp reaches the markup, and says when", () => {
    const html = row({ snoozedUntil: NOW - 30 * MINUTE, snoozedAt: NOW - 3 * 60 * MINUTE, wokeAt: NOW - 30 * MINUTE });
    expect(html).toContain('aria-label="Woke up"');
    // The label carries the ENGINE's instant, not the render's: 30 minutes, not
    // "just now". A dot lit from a client-side comparison of `snoozedUntil`
    // against this cockpit's clock would pass the line above and fail this one.
    expect(html).toContain("Woke 30m ago");
  });

  test("and the slim row draws it too — a settled row that woke still woke", () => {
    const html = row({ snoozedUntil: NOW - 30 * MINUTE, snoozedAt: NOW - 3 * 60 * MINUTE, wokeAt: NOW - 30 * MINUTE }, { variant: "slim" });
    expect(html).toContain('aria-label="Woke up"');
  });

  /**
   * THE NEGATIVE DIRECTION, run on the same path. Without it the assertions
   * above are satisfied by a row that draws the dot unconditionally, which is
   * the one bug this whole change could plausibly ship.
   */
  test("a session that never slept carries nothing", () => {
    expect(row()).not.toContain('aria-label="Woke up"');
  });

  test("a session still asleep carries nothing — the deadline has not passed", () => {
    // Snoozed for another half hour. The engine has not stamped a wake, so
    // there is no wake to draw — and the countdown asserts the row really did
    // render as a sleeping one, rather than the dot being absent because
    // nothing rendered at all.
    const html = row({ snoozedUntil: NOW + 30 * MINUTE, snoozedAt: NOW - 30 * MINUTE }, { band: "snoozed" });
    expect(html).not.toContain('aria-label="Woke up"');
    expect(html).toContain("30m");
  });

  test("a snooze whose deadline has passed but which the engine has not swept carries nothing", () => {
    // THIS IS THE CASE THAT DISTINGUISHES THE TWO IMPLEMENTATIONS. The deadline
    // is an hour old, so a per-device `snoozedUntil <= now` would light the dot
    // here — on every cockpit, at whatever moment each one's clock said. The
    // wake is the engine's to declare and it has not declared one.
    expect(row({ snoozedUntil: NOW - 60 * MINUTE, snoozedAt: NOW - 3 * 60 * MINUTE })).not.toContain('aria-label="Woke up"');
  });
});

describe("the projection is what carries it", () => {
  test("toSidebarSession forwards the engine's stamp unchanged", () => {
    expect(toSidebarSession(liveRow({ snoozedUntil: NOW - MINUTE, snoozedAt: NOW - MINUTE * 2, wokeAt: NOW - MINUTE })).wokeAt).toBe(NOW - MINUTE);
  });

  test("and omits the key entirely when the engine sent none", () => {
    // Absent rather than `undefined`-valued, like every other optional on this
    // projection — `exactOptionalPropertyTypes` is on in this workspace.
    expect("wokeAt" in toSidebarSession(liveRow())).toBe(false);
  });
});
