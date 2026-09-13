/**
 * WHERE THE RAIL'S BANDS SIT — issue #278, first half.
 *
 * Pinned conversations used to be held out of the scrolling list so they stayed
 * on screen. They now sit FIRST INSIDE it and travel with it; "Needs you" is the
 * one band still above the scroll, because nobody asks to be blocked.
 *
 * ASSERTED AS SOURCE TEXT, which is the idiom `session/context-menus.test.tsx`
 * establishes for this file and for the same reason: `AppSidebar` is a client
 * component behind the engine client, hosts, localStorage and a polling effect,
 * and what is being pinned here is not what it renders from some fixture — it is
 * WHICH BOX each band is nested in. That is a structural fact about the source,
 * and a server render of a mocked-out sidebar would prove it less directly than
 * reading the nesting itself.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const source = fs.readFileSync(path.join(dir, "app-sidebar.tsx"), "utf8");

/** Comments stripped: the prose below explains the very rules being scanned for,
 *  so a scan that read it would pass on the explanation and teach the next
 *  person to delete the comment. Same reason `context-menus.test.tsx` does it. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The one scrolling box in the rail's list. */
const SCROLL = 'id="sidebar-session-results"';
const PINNED = 'aria-label="Pinned"';
const ATTENTION = 'aria-label="Needs you"';

const at = (needle: string) => {
  const index = code.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return index;
};

describe("pinned scrolls with the rail", () => {
  test("the pinned band is INSIDE the scrolling container", () => {
    // The bug: a `shrink-0` band before the `overflow-y-auto` list meant six
    // pinned conversations took six rows of fixed height and everything else
    // scrolled through what was left.
    const scroll = at(SCROLL);
    const pinned = at(PINNED);
    expect(pinned).toBeGreaterThan(scroll);
    // …and inside that container's own element, not merely after it opens: the
    // container closes once, and pinned lands before that.
    expect(pinned).toBeLessThan(code.indexOf("</SidebarGroupContent>", scroll));
  });

  test("it sits FIRST — above every project group", () => {
    // The RENDER site, not `drawnGroupKeys`: that one also maps the groups and
    // is declared far above the JSX, so anchoring on it would pass by accident.
    expect(at(PINNED)).toBeLessThan(at("<ProjectGroupSection"));
  });

  test("it is not held out of the scroll by a height of its own", () => {
    // `shrink-0` on the band is exactly what "above the scroll" was made of.
    const band = code.slice(at(PINNED) - 400, at(PINNED) + 400);
    expect(band).not.toContain("shrink-0");
  });

  test("NO STICKY. A row that detaches from its own band mid-scroll is a third behaviour", () => {
    expect(code).not.toContain("sticky");
  });

  test('"Needs you" stays above the scroll — the engine cannot continue without you', () => {
    const band = at("grouped.attention.length > 0 && (");
    expect(at(ATTENTION)).toBeLessThan(at(SCROLL));
    // Held out of the scroll by its own fixed height, which is what pinned gave up.
    expect(code.slice(band, at(ATTENTION))).toContain("shrink-0");
  });
});

/**
 * EVERY CONVERSATION IS A ROW OF ITS OWN BAND — issue #381.
 *
 * The rail drew a delegated conversation as its coordinator's indented child
 * (#199 in the pinned band, #324 everywhere else), which made a separate
 * conversation read as a sub-agent of the one above it. It is not one, so the
 * tree is gone: no `relatedTree`, no elbow, no rows withheld from a project
 * group, and no clock deciding when a child stops being drawn (#370/#372).
 * Who delegated what to whom is stated on the panel's Agents surface instead.
 *
 * Scanned as SOURCE for this file's own reason: what is being pinned is that a
 * call site no longer exists, which a render of a mocked-out rail could only
 * show indirectly.
 */
describe("the rail draws no tree", () => {
  test("nothing arranges rows under other rows", () => {
    for (const gone of ["relatedTree", "RelatedWork", "relatedWork", "withholdFollowedRows", "followedSessions"]) {
      expect(code, `${gone} is tree machinery and the rail is done with it`).not.toContain(gone);
    }
  });

  test("the pinned band maps straight to rows, with nothing nested under one", () => {
    const band = code.slice(at(PINNED), code.indexOf("</div>", at(PINNED)));
    expect(band).toContain("<SessionRow");
    // The wrapper each pinned row used to need so its children could follow it.
    expect(band).not.toContain('<div key={sessionKey(session)} className="space-y-0.5">');
  });

  test("a project group is handed its rows and no settling window to arrange them by", () => {
    const call = code.slice(at("<ProjectGroupSection"), at("<ProjectGroupSection") + 1200);
    expect(call).not.toContain("autoSettleAfterHours=");
    expect(call).not.toContain("settlingWindows=");
  });
});
