/**
 * #576 — THE SOLO ROUTE NEVER MOUNTS THE APP RAIL.
 *
 * NOT "IS IT HIDDEN". The owner refused the cheap version of this issue for a
 * reason the DOM can be asked about directly: a rail collapsed to 48px is still
 * mounted, still in the layout and still downloaded, which on a headset already
 * simulating a room is the cost that matters. So every assertion below is about
 * PRESENCE IN THE TREE, and one of them is about whether the module was ever
 * pulled in at all — the test-time reading of "does not fetch its chunk", which
 * is what `dynamic()` buys and what a CSS rule cannot.
 *
 * THE RAIL IS REPLACED BY A MARKER. `app-sidebar.tsx` is the largest component
 * in the app and drags the command palette in behind it; what this file is
 * about is whether the shell ASKS for it, and a stub answers that exactly while
 * keeping the test a test rather than a render of the whole cockpit.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

/** How many times the shell's `dynamic()` loader actually reached for the rail
 *  module. Zero on a route that does not draw one is the claim the issue is
 *  about; the chunk is not requested because the import is never evaluated. */
let railLoads = 0;
mock.module("./app-sidebar", () => {
  railLoads += 1;
  return { AppSidebar: () => <div data-testid="app-rail">rail</div> };
});

const { AppShell } = await import("./app-shell");

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * Render the shell at one address and let the rail's loader settle.
 *
 * `next/dynamic` is react-loadable here, not `React.lazy`: it renders nothing
 * until the import resolves and then swaps the component in on a subscription.
 * So an assertion taken in the first commit would read "no rail" on EVERY
 * route, which is the one way this test could pass while saying nothing.
 */
async function show(at: string) {
  pathname = at;
  await act(async () => {
    root!.render(
      <AppShell>
        <p>conversation</p>
      </AppShell>,
    );
  });
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

const rail = () => host!.querySelector('[data-testid="app-rail"]');

describe("the rail, per route", () => {
  /**
   * THIS ONE IS FIRST ON PURPOSE, and the order is part of the assertion.
   * Modules are cached, so the loader can only be observed NOT running before
   * anything else in this file has caused it to run — a `railLoads` check after
   * an ordinary route would read 0 whatever the shell did.
   */
  test("the solo conversation does not, and never asks for its module", async () => {
    await show("/projects/project_1/sessions/session_a/solo");
    expect(rail()).toBeNull();
    expect(railLoads).toBe(0);
    // The conversation itself is still the shell's child: this route loses the
    // rail, not the screen.
    expect(host!.textContent).toContain("conversation");
  });

  test("an ordinary conversation draws it — which is what makes the test above mean something", async () => {
    await show("/projects/project_1/sessions/session_a");
    expect(rail()).not.toBeNull();
    expect(railLoads).toBe(1);
    expect(host!.textContent).toContain("conversation");
  });

  test("nor does the solo conversation on a paired Mac", async () => {
    await show("/hosts/mac-2/projects/project_1/sessions/session_a/solo");
    expect(rail()).toBeNull();
  });

  test("but an ordinary conversation ON THAT MAC still does — the suffix is what decides, not the prefix", async () => {
    await show("/hosts/mac-2/projects/project_1/sessions/session_a");
    expect(rail()).not.toBeNull();
  });

  test("a session whose id merely ends in the word does not count as solo", async () => {
    // `.../sessions/session_solo` is a session, not a view of one. The matcher
    // reads a SEGMENT, which is the whole reason this is a path and not a
    // string the address happens to contain.
    await show("/projects/project_1/sessions/session_solo");
    expect(rail()).not.toBeNull();
  });

  test("settings still skips it too — the second route through the same door", async () => {
    await show("/settings");
    expect(rail()).toBeNull();
  });
});
