// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * THE NAV AFTER TWO CHANGES A PERSON ASKED FOR: Application folded into General,
 * and one Plugins destination instead of an item per plugin.
 *
 * Read from the source rather than rendered, because what is being pinned is the
 * ROUTE CONTRACT — a section id that stops answering strands a bookmark, and the
 * OAuth callback redirects to one of these by name.
 */
const source = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

test("Application is gone from the nav but its id still answers", () => {
  // The pane merged into General. The alias is what keeps a bookmark — and the
  // `about`/`updates` ids that already redirected here — from landing on the
  // default pane instead.
  expect(source).not.toContain('{ id: "application"');
  expect(source).toContain('application: "general"');
  expect(source).toContain('updates: "general"');
  expect(source).toContain('about: "general"');
});

test("what Application used to render now renders in General", () => {
  const general = source.slice(source.indexOf('active === "general"'), source.indexOf('active === "plugins"'));
  expect(general).toContain("<AboutSection");
  expect(general).toContain("<UpdatesSection");
});

test("ONE Plugins destination, not an item per plugin", () => {
  // Two plugins ship today and the list grows; a nav item each would crowd out
  // the things a person opens settings for.
  expect(source).toContain('{ id: "plugins"');
  expect(source).not.toContain('{ id: "latex"');
  expect(source).not.toContain('{ id: "data-science"');
  expect(source).toContain("<PluginsPage />");
});

test("Browser is a pane of its own, under Cockpit, and holds both groups", () => {
  // Profiles and remembered logins are one subject: a grant is scoped to a
  // profile, so reading one while the other lived in Agent tools meant holding a
  // profile list in your head.
  expect(source).toContain('{ id: "integrations"');
  // Named for what it is (#357) — "Integrations" is every app's word for the
  // drawer of things it connects to, and named a category rather than this pane.
  expect(source).toContain('label: "Browser"');
  expect(source).not.toContain('label: "Integrations"');
  expect(source).toContain('<IntegrationsPage />');
  const tools = source.slice(source.indexOf('active === "tools"'));
  expect(tools.slice(0, 300)).not.toContain("<BrowserLoginsSection");
});

test("the Browser pane wears a browser's glyph, not the plug it had as Integrations", () => {
  // #430: the label was fixed in #357 and the icon was not, so the nav kept
  // saying "things Telar connects to" in the one place a label cannot. The
  // right panel already draws the browser as a globe — same subject, same glyph.
  expect(source).toContain('{ id: "integrations", label: "Browser", icon: GlobeIcon');
  expect(source).not.toContain("PlugZapIcon");
});

test("the renamed pane keeps its route, so a bookmark still lands", () => {
  // The label is nav copy; the id is a contract. Renaming one is not a reason
  // to strand the other.
  expect(source).toContain('active === "integrations"');
});

test("Settled is gone from the nav, and its id lands on the rule that fills it", () => {
  /**
   * #364: the pane listed the conversations this rail has shelved, which is a
   * SHELF — the rail already draws one, and that is where anyone looking for a
   * settled conversation goes. What is genuinely a setting is the rule that
   * puts them there, so a bookmark lands on General ▸ Settling rather than on
   * the default pane.
   */
  expect(source).not.toContain('{ id: "settled"');
  expect(source).not.toContain("<SettledPage");
  expect(source).toContain('settled: "general"');
});

test("Schedules is not a Settings pane: a schedule belongs to its session", () => {
  // It lives in the session's masthead now (session/session-schedules.tsx).
  expect(source).not.toContain('{ id: "schedules"');
  expect(source).not.toContain("SchedulesSection");
  expect(source).not.toContain('agent: "schedules"');
});

test("the OAuth callback's section id is still routable", () => {
  // `section=mcp` is baked into app/api/mcp/oauth/callback/route.ts.
  expect(source).toContain('mcp: "tools"');
});

test("Storage is a pane under Runtime, and it reads numbers → checkouts → store (#642)", () => {
  expect(source).toContain('{ id: "storage", label: "Storage"');
  const pane = source.slice(source.indexOf('active === "storage"'), source.indexOf('active === "plugins"'));
  for (const section of ["<StorageSection />", "<WorktreesRootSection />", "<WorktreeListSection />", "<StoreSection />"]) {
    expect(pane).toContain(section);
  }
  /**
   * THE ORDER IS THE ARGUMENT. Read what is on disk, then the cheap safe move
   * (checkouts are re-cut from a recorded commit, so Telar still starts
   * without the drive), then the whole-store move that cannot start without
   * it. Putting the expensive option first would make it the default reading.
   */
  expect(pane.indexOf("<StorageSection />")).toBeLessThan(pane.indexOf("<WorktreesRootSection />"));
  expect(pane.indexOf("<WorktreesRootSection />")).toBeLessThan(pane.indexOf("<StoreSection />"));
  /**
   * AND THE LIST READS UNDER THE LOCATION (#671), because that is the order the
   * question arrives in: somebody reads "Session checkouts — 7.3 GB" and where
   * they go, and the next thing they want is WHICH of them are finished. It
   * stays above the store move for the same reason the location does — the
   * cheap, reversible option before the expensive one.
   */
  expect(pane.indexOf("<WorktreesRootSection />")).toBeLessThan(pane.indexOf("<WorktreeListSection />"));
  expect(pane.indexOf("<WorktreeListSection />")).toBeLessThan(pane.indexOf("<StoreSection />"));
});

test("the store's location left General with the pane that reports what is in it", () => {
  /**
   * #630 put it beside Updates — both facts about this install, applied at the
   * next launch — which was right while it was one row. A pane that reports
   * what the store holds and a row on ANOTHER pane that moves the store are one
   * question answered in two places, and the half that can move it was the half
   * further from the numbers.
   */
  const general = source.slice(source.indexOf('active === "general"'), source.indexOf('active === "storage"'));
  expect(general).not.toContain("<StoreSection");
  // Nothing is stranded: the row never had a section id of its own to bookmark.
  expect(source).not.toContain('store: "');
});
