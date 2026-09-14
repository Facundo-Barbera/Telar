/**
 * THE BAR THAT SAYS THE BROWSER IS PAUSED (#480).
 *
 * The sentences are tested as functions and the markup as markup, the split
 * this app uses everywhere (see `browser-permission-prompt.test.tsx`). Both
 * matter here for the same reason they do there: a pause nobody can see is
 * indistinguishable from a broken browser, which is the bug this fixes — and a
 * recovery button that quietly stopped being rendered puts it straight back.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserPrivacyBanner, describePrivacy, namePrivacyHolders, type DesktopPrivacyState } from "./browser-privacy-banner";

const privacy = (patch: Partial<DesktopPrivacyState> = {}): DesktopPrivacyState => ({
  private: true,
  epoch: 3,
  reason: "credentials filled",
  holding: [{ id: "tab_1", label: "Acme — Sign in" }],
  ...patch,
});

const resume = async () => privacy();

describe("naming the page that holds the window", () => {
  test("one page is named outright", () => {
    expect(namePrivacyHolders([{ id: "t", label: "Acme — Sign in" }])).toBe("Acme — Sign in");
  });

  test("several are named by the first and counted", () => {
    const two = [{ id: "a", label: "Acme" }, { id: "b", label: "Beta" }];
    expect(namePrivacyHolders(two)).toBe("Acme and 1 other page");
    expect(namePrivacyHolders([...two, { id: "c", label: "Gamma" }])).toBe("Acme and 2 other pages");
  });

  test("an older shell that names none is not a bug to report", () => {
    expect(namePrivacyHolders(undefined)).toBeNull();
    expect(namePrivacyHolders([])).toBeNull();
  });
});

describe("what the bar says", () => {
  /**
   * The two states are NOT two degrees of one warning. "A sign-in is in
   * progress" is the system working as designed and asks for nothing; "not
   * answering" is the system stuck and names the way out. Tone follows that,
   * so an ordinary sign-in never paints the panel with a warning colour.
   */
  test("an ordinary sign-in explains itself and asks for nothing", () => {
    const copy = describePrivacy(privacy());
    expect(copy.tone).toBe("info");
    expect(copy.headline).toContain("Browser tools are paused");
    expect(copy.headline).toContain("Acme — Sign in");
    expect(copy.hint).toBeNull();
  });

  test("a wedged page says so, and says what to do", () => {
    const copy = describePrivacy(privacy({ stuck: true }));
    expect(copy.tone).toBe("warn");
    expect(copy.headline).toContain("Acme — Sign in");
    expect(copy.headline).toContain("not answering");
    expect(copy.hint).toContain("Reload or close");
    expect(copy.hint).toContain("resume them here");
  });

  test("a shell with no resume door does not offer one in words either", () => {
    expect(describePrivacy(privacy({ stuck: true }), false).hint).not.toContain("resume them here");
  });

  test("with no page named, the sentences still stand on their own", () => {
    expect(describePrivacy(privacy({ holding: [] })).headline).toBe("Browser tools are paused: a sign-in is in progress.");
    expect(describePrivacy(privacy({ holding: [], stuck: true })).headline).toBe("Browser tools are paused: the sign-in page is not answering.");
  });
});

describe("the markup", () => {
  test("an ordinary sign-in draws no button — the release is automatic", () => {
    const html = renderToStaticMarkup(<BrowserPrivacyBanner privacy={privacy()} onResume={resume} />);
    expect(html).toContain("a sign-in is in progress");
    // A button here would invite somebody to click through their own sign-in.
    expect(html).not.toContain("Resume");
  });

  test("a wedged page draws Resume — and NOT Resume anyway, which is not offered until Resume is refused", () => {
    const html = renderToStaticMarkup(<BrowserPrivacyBanner privacy={privacy({ stuck: true })} onResume={resume} />);
    expect(html).toContain("not answering");
    expect(html).toContain(">Resume<");
    expect(html).not.toContain("Resume anyway");
  });

  test("an older shell with no resume bridge still says what is happening, and offers nothing that cannot work", () => {
    const html = renderToStaticMarkup(<BrowserPrivacyBanner privacy={privacy({ stuck: true })} />);
    expect(html).toContain("not answering");
    expect(html).not.toContain("Resume");
  });
});

/**
 * The bar is useless if the panel stops drawing it, and this component cannot
 * see whether it does. `browser-live.tsx` is a 1800-line stateful surface with
 * no DOM harness of its own, so the wiring is scanned — the same thing
 * `browser-live.test.ts` does for the address row's budget.
 */
describe("the browser panel actually draws it", () => {
  const source = fs.readFileSync(path.join(fileURLToPath(new URL(".", import.meta.url)), "browser-live.tsx"), "utf8");

  test("the bar is rendered while privacy is on, above the tab strip", () => {
    expect(source).toContain("{state?.privacy?.private ? (");
    expect(source).toContain("<BrowserPrivacyBanner privacy={state.privacy}");
    // Above the strip, not inside it: the pause is on the whole browser.
    expect(source.indexOf("<BrowserPrivacyBanner")).toBeLessThan(source.indexOf('role="tablist"'));
  });

  test("Resume reaches the shell, and is simply absent on a shell without it", () => {
    expect(source).toContain("{...(bridge.resumeFromPrivate ? { onResume: bridge.resumeFromPrivate } : {})}");
  });

  /**
   * The bar is a ROW ABOVE THE STRIP, so it pushes the native `WebContentsView`
   * down — and the shell only re-places that view when this key changes. Left
   * out, the page would sit one bar-height too high for as long as the sign-in
   * lasted, with the bottom of it clipped.
   */
  test("its two heights are in the viewport's layout key", () => {
    expect(source).toContain("Boolean(state?.privacy?.private), Boolean(state?.privacy?.stuck)");
  });
});
