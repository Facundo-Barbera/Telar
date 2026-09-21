/**
 * THE RAIL DRAWS NOTHING — issue #905.
 *
 * The rail used to paint a 2px `after:` bar down the gap between the sidebar
 * and the main column, dim at rest and bright on hover. It never landed on the
 * seam it was meant to trace: the 16px strip sits `-right-4` and is then pulled
 * back by half its width, so its midline is off the gap's centre and the bar
 * read as a stray stroke beside the islands rather than an edge between them.
 * The owner's ruling was that there should be no line at all — `col-resize` is
 * the affordance, and two floating islands have no seam to draw.
 *
 * RENDERED, not read from source. The claim is about what reaches the DOM: a
 * rail whose bar moved into a child `<span>`, or a class list that kept one
 * `after:bg-*` among the dozen conditional strings `cn` folds together, would
 * both pass a scan of the JSX and still put the line back on screen.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, SidebarProvider, SidebarRail } from "./sidebar";

/** The rail's own element, out of whatever the shell rendered around it. */
function rail(markup: string): string {
  const start = markup.indexOf("<button");
  const at = markup.indexOf('data-sidebar="rail"');
  expect(at).toBeGreaterThan(-1);
  // The rail is the only button in these fixtures, so the first one is it.
  expect(start).toBeLessThan(at);
  return markup.slice(start, markup.indexOf("</button>", at) + "</button>".length);
}

/** A rail that is a resize handle — the shape the off-centre line appeared on. */
const resizing = () =>
  rail(
    renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar resizable>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    ),
  );

/** And a rail that is only a toggle, which drew the same bar. */
const toggling = () =>
  rail(
    renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    ),
  );

describe("the sidebar rail paints no seam", () => {
  for (const [name, render] of [
    ["as a resize handle", resizing],
    ["as a toggle", toggling],
  ] as const) {
    test(`${name}, it renders no child element`, () => {
      // Empty, not merely free of `after:` — the bar could come back as a
      // child `<span>`, which is exactly how Settings drew its own copy.
      expect(render()).toMatch(/<button\b[^>]*><\/button>/);
    });

    test(`${name}, it carries no after:bg-* class`, () => {
      const html = render();
      expect(html).not.toContain("after:bg-");
      expect(html).not.toContain("after:w-[2px]");
    });
  }

  test("the hit area, the cursor and the keyboard path all survive", () => {
    const html = resizing();
    // Removing the paint must not remove the handle: a 16px strip that takes
    // the pointer, says what it does, and can be reached by keyboard.
    expect(html).toContain("w-4");
    expect(html).toContain("cursor-w-resize");
    expect(html).toContain("touch-none");
    expect(html).toContain('aria-label="Resize Sidebar"');
    expect(html).toContain('tabindex="0"');
  });

  test("keyboard focus still shows, as a ring on the strip itself", () => {
    // The old focus state coloured the bar. With the bar gone the focus has to
    // land somewhere, or the rail becomes reachable and invisible.
    expect(resizing()).toContain("focus-visible:ring-ring");
    expect(resizing()).not.toContain("focus-visible:after:");
  });
});
