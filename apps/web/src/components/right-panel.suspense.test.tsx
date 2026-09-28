/**
 * THE FIRST OPEN OF A SURFACE STAYS INSIDE THE PANEL — issue #896.
 *
 * The symptom was "opening the Editor flashes the whole cockpit, but only the
 * first time". The cause is one line of Next's: `dynamic()` in the App Router
 * hands `Loadable` neither `ssr: false` nor a `loading`, and `Loadable` adds a
 * `Suspense` of its own ONLY when it has one of those — otherwise it wraps its
 * `React.lazy` in a bare `Fragment`. So the first render of a chunk nobody has
 * fetched suspends up to the nearest boundary, which for a conversation is the
 * route's `loading.tsx`. The whole conversation is replaced by the page
 * skeleton and drawn again when the chunk lands. Second open, module cached, no
 * suspension, no flash — which is why it read as a haunting rather than a bug.
 *
 * WHY THIS FILE STANDS THE SHIPPED SHAPE UP BY HAND rather than trusting the
 * `next/dynamic` it can import. There are two of them. The App Router build
 * resolves `next/dynamic` to `dist/shared/lib/app-dynamic.js`, which passes no
 * `loading` and therefore gets the Fragment. Outside a Next build — here, under
 * bun — the package's own export map resolves it to `dist/shared/lib/dynamic.js`,
 * the pages-router spelling, and THAT one defaults `loading` to a function. Its
 * `Loadable` therefore always has a boundary, with a fallback that renders
 * null. Mounting the real panel here and watching for the route's fallback
 * would be green with the fix and green without it: the environment supplies
 * the boundary the bug is about. `boundary is the difference` below is
 * therefore built on the App Router's shape, and `the premise` pins that shape
 * against the day a Next upgrade moves it.
 *
 * `the panel opens` at the end is the end-to-end leg, and its reach is smaller
 * than it looks for the reason just given: it says the panel commits its
 * `<aside>` on the first frame and keeps that same node while a surface's chunk
 * resolves. It is NOT what holds our `Suspense` in place — the
 * `dynamic-render-sites-have-a-boundary` invariant in scripts/source-invariants.mjs
 * is, and it is the thing to fix if it ever goes red.
 *
 * The DOM is registered for this file and handed back in `afterAll`, because
 * the suite shares one process and its neighbours are written for a world with
 * no `window` in it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Fragment, Suspense, act, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RightPanel, type PanelTabItem } from "./right-panel";

GlobalRegistrator.register({ url: "http://localhost/projects/project_a/sessions/session_a" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** A quiet moment — long enough for a frame, when there are frames. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** The route's own boundary, standing in for `app/…/sessions/[sessionId]/loading.tsx`.
 *  Its fallback appearing IS the reload the owner reported. */
const ROUTE_FALLBACK = "route-fallback";
const routeFallback = (host: HTMLElement) => host.querySelector(`[data-testid="${ROUTE_FALLBACK}"]`);

function mount(tree: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Suspense fallback={<div data-testid={ROUTE_FALLBACK} />}>{tree}</Suspense>);
  });
  return {
    host,
    settle: () => act(async () => void (await settle())),
    /**
     * Quiet moments until `done`, or until the budget runs out. A real chunk is
     * a module graph bun has to read and transpile the first time, and how many
     * milliseconds that takes is a property of the machine — so the wait for
     * one is a condition rather than a number. Every frame in between is still
     * a frame this file gets to assert on, which is the point.
     */
    settleUntil: async (done: () => boolean, budgetMs = 5_000) => {
      const deadline = Date.now() + budgetMs;
      while (!done() && Date.now() < deadline) await act(async () => void (await settle()));
      return done();
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("the premise: next/dynamic in the App Router brings no boundary", () => {
  // Resolved the way the app resolves it, rather than by a path spelled here:
  // a hoisted install puts `next` somewhere no relative walk would find, and a
  // hard-coded one would rot into a file-not-found that reads as this check
  // being unnecessary.
  const resolve = createRequire(import.meta.url).resolve;
  const next = (path: string) => readFileSync(resolve(`next/dist/shared/lib/${path}`), "utf8");

  test("`Loadable` wraps in Suspense only for a non-SSR or a `loading` declaration", () => {
    // The gate itself. Every claim in this file rests on this one expression,
    // so it is read off Next rather than remembered.
    expect(next("lazy-dynamic/loadable.js")).toContain("const hasSuspenseBoundary = !opts.ssr || !!opts.loading;");
  });

  test("the App Router's `dynamic` declares neither, so `Loadable` wraps in a Fragment", () => {
    const source = next("app-dynamic.js");
    expect(source).toContain("loadableOptions.loader = dynamicOptions;");
    // No `loading` and no `ssr` anywhere in the file: whatever the call site
    // omits, this one omits too.
    expect(source).not.toContain("loading:");
    expect(source).not.toContain("ssr:");
  });

  test("the pages-router `dynamic` this suite resolves DOES default `loading` — which is why the mounts below build the shape by hand", () => {
    expect(next("dynamic.js")).toContain("loading: ({ error, isLoading, pastDelay })");
    expect(resolve("next/dynamic")).not.toContain("app-dynamic");
  });
});

describe("the boundary is the difference between a panel that waits and a page that reloads", () => {
  /**
   * `Loadable`'s output for `dynamic(() => import(…))` in the App Router,
   * verbatim: a `React.lazy` in a `Fragment`, and nothing else. The promise is
   * the test's, so "the chunk has not been fetched yet" is a state this can sit
   * in rather than race against.
   */
  function shippedDynamic() {
    let land: () => void = () => {};
    const chunk = new Promise<void>((resolve) => {
      land = resolve;
    });
    const Lazy = lazy(async () => {
      await chunk;
      return { default: () => <p data-testid="surface">the surface</p> };
    });
    const Surface = () => (
      <Fragment>
        <Lazy />
      </Fragment>
    );
    return { Surface, land };
  }

  /** The panel's own shape around it: the `<aside>` whose survival is the
   *  claim, and the scrolling body the surface is rendered into. */
  const panel = (body: ReactNode) => (
    <aside aria-label="Right panel">
      <div role="tabpanel">{body}</div>
    </aside>
  );

  test("WITH the panel's own Suspense: the route never falls back and the aside is never rebuilt", async () => {
    const { Surface, land } = shippedDynamic();
    const { host, settle: quiet, unmount } = mount(
      panel(
        <Suspense fallback={null}>
          <Surface />
        </Suspense>,
      ),
    );

    // The frame the owner saw: the chunk is outstanding and the panel is
    // already on screen.
    expect(routeFallback(host)).toBe(null);
    const aside = host.querySelector("aside");
    expect(aside).not.toBe(null);

    land();
    await quiet();

    expect(routeFallback(host)).toBe(null);
    expect(host.querySelector('[data-testid="surface"]')).not.toBe(null);
    // The same NODE, not merely a node: a rebuilt aside is a redrawn panel,
    // which loses scroll position, focus and any native view composited over it.
    expect(host.querySelector("aside")).toBe(aside);
    unmount();
  });

  /**
   * THE NEGATIVE CONTROL, and the reason this file is worth its runtime. An
   * assertion that the route fallback stays away is only evidence if the same
   * arrangement without the boundary produces it — otherwise it is a test of
   * nothing, passing for a reason unrelated to the fix.
   */
  test("WITHOUT it: the route falls back, and the panel is thrown away and built again", async () => {
    const { Surface, land } = shippedDynamic();
    const { host, settle: quiet, unmount } = mount(panel(<Surface />));

    expect(routeFallback(host)).not.toBe(null);
    expect(host.querySelector("aside")).toBe(null);

    land();
    await quiet();

    expect(routeFallback(host)).toBe(null);
    expect(host.querySelector("aside")).not.toBe(null);
    unmount();
  });
});

describe("the panel opens a surface without giving the route anything to do", () => {
  const tab = (id: string, kind: string, params: Record<string, string> = {}): PanelTabItem =>
    ({ id, kind, params }) as PanelTabItem;

  /** The Diff surface reads the engine on mount, and keeps reading after the
   *  chunk lands; nothing here is about what it finds, so every request is
   *  answered with an empty object for the whole life of the mount. */
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a first open commits the panel's aside straight away and keeps that node while the chunk lands", async () => {
    globalThis.fetch = (async () => Response.json({})) as typeof fetch;
    const { host, settleUntil, unmount } = mount(
      <RightPanel
        sessionId="session_a"
        projectId="project_a"
        tabs={[tab("diff", "diff")]}
        tab="diff"
        onTabChange={() => {}}
        onOpenTab={() => {}}
        onCloseTab={() => {}}
        onClose={() => {}}
      />,
    );

    expect(routeFallback(host)).toBe(null);
    const aside = host.querySelector("aside");
    expect(aside).not.toBe(null);

    // Every frame of the wait is read, not just its two ends: a flash is by
    // definition a frame in the middle, and a pair of before/after assertions
    // is exactly the instrument that cannot see one.
    let flashed = false;
    const surfaceArrived = () => {
      if (routeFallback(host)) flashed = true;
      return (host.querySelector('[role="tabpanel"]')?.innerHTML ?? "") !== "";
    };
    // The surface really did arrive — without this the claims either side
    // would hold just as well for a panel whose body never rendered at all.
    expect(await settleUntil(surfaceArrived)).toBe(true);

    expect(flashed).toBe(false);
    expect(host.querySelector("aside")).toBe(aside);
    unmount();
  });
});
