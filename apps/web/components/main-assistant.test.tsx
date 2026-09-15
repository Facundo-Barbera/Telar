/**
 * `/main` — the reserved address for this Mac's coordinator (#526).
 *
 * AGAINST THE DECISION, NOT THE RENDER TREE. What this screen does is three
 * decisions — has the engine answered, is anything designated, is the key
 * usable — and `mainAssistantView` is where they live precisely so a test does
 * not have to stand up a whole cockpit's polling to ask about them. The
 * notice's own markup is checked separately, because the wording is the point
 * of it.
 *
 * NO MODULE MOCKS HERE, deliberately: `mock.module` is process-global in bun,
 * and stubbing `@/components/session-cockpit` from this file would replace the
 * real one inside `session-cockpit.switch.test.tsx`, which mounts it for real.
 * A seam that needs a global mock is a seam in the wrong place.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MainKeyNotice, mainAssistantView, mainSettingsHref, MAIN_SETTINGS_HREF } from "./main-assistant";

const on = { enabled: true, sessionId: "session_main" };

describe("what /main resolves to", () => {
  test("nothing at all until the engine has answered once", () => {
    // The default is OFF, so answering "off" here would be wrong for exactly
    // the reader who opened this screen to use a Main that IS on.
    expect(mainAssistantView({ main: { enabled: false }, loading: true })).toEqual({ kind: "loading" });
    expect(mainAssistantView({ main: on, loading: true })).toEqual({ kind: "loading" });
  });

  test("off, including designated-but-off — the id outlives the switch", () => {
    expect(mainAssistantView({ main: { enabled: false }, loading: false })).toEqual({ kind: "off" });
    // Disabling keeps the id so re-enabling reuses the same conversation; a
    // screen reading the id alone would open one for a feature that is off.
    expect(mainAssistantView({ main: { enabled: false, sessionId: "session_main" }, loading: false })).toEqual({ kind: "off" });
    // On with nothing designated is a state the engine does not write, and is
    // still not a screen that can render a conversation.
    expect(mainAssistantView({ main: { enabled: true }, loading: false })).toEqual({ kind: "off" });
  });

  test("on with a working key is the conversation and nothing else", () => {
    expect(mainAssistantView({ main: on, loading: false, credential: { source: "setting", rejected: false } })).toEqual({
      kind: "session",
      sessionId: "session_main",
    });
  });

  test("an engine too old to report a credential says nothing — absent is not 'no key'", () => {
    expect(mainAssistantView({ main: on, loading: false })).toEqual({ kind: "session", sessionId: "session_main" });
  });

  test("no source is 'missing'; a refusal is 'rejected', whichever rung it came from", () => {
    expect(mainAssistantView({ main: on, loading: false, credential: {} })).toMatchObject({ notice: "missing" });
    // A rejected CLI-sourced key is the case the correction named: the key
    // exists, it simply does not work, and that is a different sentence.
    expect(mainAssistantView({ main: on, loading: false, credential: { source: "cli", rejected: true } })).toMatchObject({
      notice: "rejected",
    });
    // Rejection outranks having a source: a key that is there and refused must
    // not read as "using the key saved here" and nothing else.
    expect(mainAssistantView({ main: on, loading: false, credential: { source: "setting", rejected: true } })).toMatchObject({
      notice: "rejected",
    });
  });
});

describe("the notice", () => {
  test("having no key and having a refused one are different sentences", () => {
    const missing = renderToStaticMarkup(<MainKeyNotice rejected={false} />);
    expect(missing).toContain("no OpenCode Go key");
    expect(missing).toContain(`href="${MAIN_SETTINGS_HREF}"`);

    const rejected = renderToStaticMarkup(<MainKeyNotice rejected />);
    expect(rejected).toContain("refused");
    expect(rejected).not.toContain("no OpenCode Go key");
  });

  test("the settings link carries no fragment — this app has no hash-to-row navigation", () => {
    expect(MAIN_SETTINGS_HREF).not.toContain("#");
  });

  test("there is no settings link for another Mac, because there is no such page", () => {
    // Settings is scoped to the LOCAL engine and this app has no
    // `/hosts/<id>/settings` route. Composing one would be a 404 dressed as a
    // fix — worse than the local link it replaced.
    expect(mainSettingsHref()).toBe("/settings");
    expect(mainSettingsHref("local")).toBe("/settings");
    expect(mainSettingsHref("host_ab")).toBeUndefined();
  });

  test("a remote Main's notice says where to go instead of offering a link that 404s", () => {
    const markup = renderToStaticMarkup(<MainKeyNotice rejected hostId="host_ab" />);
    expect(markup).not.toContain("href=");
    expect(markup).toContain("on that Mac");
  });
});
