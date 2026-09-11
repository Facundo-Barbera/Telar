/**
 * THE COCKPIT'S TRAILING CLUSTER, AS ONE FAMILY.
 *
 * Run, Open and the pinned summary are three different components that happen
 * to sit side by side, which is exactly how they drifted apart: each was a
 * `ghost` control, so the row read as four bare glyphs and you had to hover to
 * find out which of them were buttons at all. They share a variant now, and
 * nothing in the type system says they must — so it is asserted here, against
 * the markup, rather than left to whoever edits one of them next.
 *
 * THE PANEL TOGGLE IS DELIBERATELY NOT IN THE FAMILY and is asserted to stay
 * out. It is the one control that opens a surface rather than acting on this
 * session, it sits past the cluster's edge, and it was asked to keep its quiet
 * look. A future sweep that "fixes the inconsistency" should fail this test and
 * come read this note.
 *
 * `renderToStaticMarkup`, like run-header-control.test.tsx: this is about the
 * classes the first paint carries, and no effects need to run for that.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenWorkspaceButton } from "./open-workspace-button";
import { WorkspaceInspector } from "./workspace-inspector";
import { RailToggle } from "@/components/right-panel";
import { RunHeaderControl } from "@/components/run/run-header-control";
import type { RunApi } from "@/lib/run/api";

/** The signature of the shared bordered control: `outline` is the only variant
 *  in button.tsx that paints a border token AND a background, and the only one
 *  whose `aria-expanded` state differs from its resting state — which is what
 *  these three, all popover triggers, need. */
const FAMILY = ["border-border", "bg-background"];

const runApi = {
  configurations: async () => ({ configurations: [] }),
  status: async () => ({ history: [] }),
} as unknown as RunApi;

/** The desktop bridge lives on `window`, and the Open button renders its
 *  unavailable shape without one. Installed for this file only. */
const hadWindow = "window" in globalThis;
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {
    telarDesktop: { workspace: { open: async () => ({ ok: true }), reveal: async () => ({ ok: true }) } },
  };
});
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const cluster = () => ({
  run: renderToStaticMarkup(<RunHeaderControl sessionId="session_1" api={runApi} />),
  open: renderToStaticMarkup(<OpenWorkspaceButton path="/tmp/workspace" hostId="local" />),
  summary: renderToStaticMarkup(<WorkspaceInspector projectId="project_1" tasks={[]} onOpenPanel={() => {}} />),
});

describe("the header cluster reads as buttons", () => {
  test("Run, Open and the pinned summary all carry the bordered variant", () => {
    for (const [name, html] of Object.entries(cluster())) {
      for (const signature of FAMILY) {
        expect(`${name}: ${html.includes(signature)}`).toBe(`${name}: true`);
      }
    }
  });

  test("they are the same height, so the row has one baseline", () => {
    // `sm` and `icon-sm` are both h-7; the Run pill says so in its own class
    // list because it overrides the padding around it.
    const { run, open, summary } = cluster();
    expect(run).toContain("h-7");
    expect(open).toContain("size-7");
    expect(summary).toContain("size-7");
  });

  test("the panel toggle keeps its quiet look, as asked", () => {
    const html = renderToStaticMarkup(<RailToggle open={false} onToggle={() => {}} />);
    expect(html).toContain("Open right panel");
    for (const signature of FAMILY) expect(html).not.toContain(signature);
  });
});

describe("the Open control", () => {
  // The group WRAPPER, not the word: every Button carries an
  // `in-data-[slot=button-group]:` rounding rule whether or not it is in one.
  const GROUPED = 'role="group"';

  test("is a split button: one half opens, the other offers the rest", () => {
    const html = renderToStaticMarkup(<OpenWorkspaceButton path="/tmp/workspace" hostId="local" />);
    expect(html).toContain("Choose an app to open this folder with");
    expect(html).toContain(GROUPED);
  });

  test("a remote session is refused by name rather than split", () => {
    // Nothing to split when there is nothing to open — see the component.
    const html = renderToStaticMarkup(<OpenWorkspaceButton path="/tmp/workspace" hostId="host_other" />);
    expect(html).toContain("Open workspace");
    expect(html).toContain("on another machine");
    expect(html).not.toContain(GROUPED);
  });
});
