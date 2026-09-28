/**
 * THE HOVER CARD'S ONE RULE: it must know something the row does not.
 *
 * The card used to open on every row, and on a session that had not run a turn
 * it said "— CONTEXT", "— TOKENS" over a title and a project the row was
 * already showing. Three em dashes are not a detail view; they are a hover that
 * costs a glance and repays nothing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarSession } from "@/lib/session-list";
import { SessionDetails, hasFigures } from "./session-row";

const session = (over: Partial<SidebarSession> = {}): SidebarSession =>
  ({
    id: "session_1",
    title: "Exoplanets",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    driver: "claude",
    projectName: "exoplanets",
    ...over,
  }) as SidebarSession;

describe("whether a row earns a hover card", () => {
  test("a session that has never run a turn has no figures, and therefore no card", () => {
    // `deriveSessionList` omits both keys when the engine reported no usage, so
    // absent really is absent rather than zero.
    expect(hasFigures(session())).toBe(false);
  });

  test("either figure on its own is enough", () => {
    expect(hasFigures(session({ contextTokens: 12_000 }))).toBe(true);
    expect(hasFigures(session({ tokens: 48_000 }))).toBe(true);
  });

  test("a measured zero is a figure, not an absence", () => {
    // A session whose first turn spent nothing has been asked and answered.
    expect(hasFigures(session({ contextTokens: 0 }))).toBe(true);
  });
});

describe("the stat band", () => {
  test("carries only the cells it has numbers for, and never an em dash", () => {
    const html = renderToStaticMarkup(<SessionDetails session={session({ tokens: 48_000 })} renderedAt={10} />);
    expect(html).toContain("Tokens");
    expect(html).toContain("Workspace");
    expect(html).not.toContain("Context");
    expect(html).not.toContain("—");
  });

  test("three cells when both figures are known", () => {
    const html = renderToStaticMarkup(
      <SessionDetails session={session({ tokens: 48_000, contextTokens: 12_000 })} renderedAt={10} />,
    );
    expect(html).toContain("grid-cols-3");
    expect(html).not.toContain("—");
  });
});
