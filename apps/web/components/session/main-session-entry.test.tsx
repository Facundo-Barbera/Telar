/**
 * THE RAIL'S MAIN ENTRY — when it exists, and where it goes (#522).
 *
 * TWO CLAIMS, AND THE FIRST ONE IS THE FEATURE BEING OPTIONAL: a cockpit whose
 * engine has never been switched on, or is older than the field, or has not
 * answered yet, draws the rail Telar always drew. There is no "experimental"
 * without that, and it is exactly the kind of thing a later refactor breaks by
 * treating an absent flag as a falsy object.
 *
 * The second is that the entry is an ORDINARY link into the conversation route
 * every other row uses — not a surface of its own. `sessionHref` is the one
 * spelling of that URL, so the assertion is against what it produces rather
 * than a string composed here.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MainSession } from "@telar/engine-client";
import { sessionHref, type SidebarSession } from "@/lib/session-list";
import { MainSessionEntry, mainSessionRow } from "./main-session-entry";

const row = (over: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id: "session_main", projectId: "project_one", title: "Main", ...over }) as SidebarSession;

const other = row({ id: "session_other", title: "Something else" });

describe("which row the entry draws", () => {
  test("none at all until an engine says otherwise", () => {
    const rows = [row(), other];
    // An engine older than the field, or a first read that has not landed.
    expect(mainSessionRow(rows, undefined)).toBeUndefined();
    // Switched off — the ordinary case, and every install's case out of the box.
    expect(mainSessionRow(rows, { enabled: false })).toBeUndefined();
    // Off but still designated: disabling keeps the id so re-enabling reuses it,
    // and a rail that read the id alone would draw an entry for a feature that
    // is off.
    expect(mainSessionRow(rows, { enabled: false, sessionId: "session_main" })).toBeUndefined();
    // On with nothing designated is a state the engine refuses to write, but a
    // rail must not draw an entry for it if one ever arrives.
    expect(mainSessionRow(rows, { enabled: true })).toBeUndefined();
  });

  test("the designated row, when it is on and this Mac's own", () => {
    const main: MainSession = { enabled: true, sessionId: "session_main" };
    expect(mainSessionRow([row(), other], main)?.id).toBe("session_main");
    // A designation whose conversation is not in the rows this rail holds draws
    // nothing, rather than an entry that navigates nowhere.
    expect(mainSessionRow([other], main)).toBeUndefined();
    // A PAIRED MAC'S ROW IS NOT THIS COCKPIT'S COORDINATOR. Its designation is
    // its own rail's; here it stays an ordinary row in its project group.
    expect(mainSessionRow([row({ hostId: "host_other" })], main)).toBeUndefined();
  });
});

describe("the entry itself", () => {
  test("links into the ordinary conversation route, and names the session", () => {
    const session = row({ title: "Coordination" });
    const markup = renderToStaticMarkup(<MainSessionEntry session={session} active={false} onNavigate={() => {}} />);
    expect(markup).toContain(`href="${sessionHref(session)}"`);
    expect(markup).toContain("/projects/project_one/sessions/session_main");
    expect(markup).toContain("Coordination");
    // The glyph carries the noun for everyone else; a reader who cannot see it
    // is owed the word.
    expect(markup).toContain("Main session: ");
  });

  test("a project-less coordinator links to the reserved address", () => {
    // #526's minted Main has no project, so there is no
    // `/projects/<id>/sessions/<id>` to build — and the rail must not compose
    // one with `undefined` in it.
    const session = row({ projectId: undefined, title: "Main" });
    const markup = renderToStaticMarkup(<MainSessionEntry session={session} active={false} onNavigate={() => {}} />);
    expect(markup).toContain('href="/main"');
    expect(markup).not.toContain("undefined");
  });

  test("an untitled conversation reads as Main rather than as its id", () => {
    const markup = renderToStaticMarkup(<MainSessionEntry session={row({ title: "" })} active={false} onNavigate={() => {}} />);
    expect(markup).toContain("Main");
    expect(markup).not.toContain(">session_main<");
  });

  test("the open conversation is marked as the current page", () => {
    const session = row();
    expect(renderToStaticMarkup(<MainSessionEntry session={session} active onNavigate={() => {}} />)).toContain('aria-current="page"');
    expect(renderToStaticMarkup(<MainSessionEntry session={session} active={false} onNavigate={() => {}} />)).not.toContain("aria-current");
  });
});
