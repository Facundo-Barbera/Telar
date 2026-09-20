/**
 * #497 — WHEN A RAIL ROW OPENS ITSELF AHEAD OF THE CLICK.
 *
 * MOUNTED FOR REAL, not rendered to a string, because every part of this is an
 * effect: the observer that watches the viewport, the 150 ms pause that
 * separates pointing from sweeping past, and the `/bootstrap` a warm row pays.
 * A static render runs none of them, which is exactly why it is the right tool
 * for the first assertion here and the wrong one for the rest.
 *
 * `next/link` IS STUBBED TO AN ANCHOR THAT RECORDS ITS `prefetch`. The real one
 * needs the App Router's contexts and would answer this file's question —
 * "is this row cold or warm" — only indirectly, through whether it happened to
 * issue a request. The prop IS the decision; read it directly.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `prefetch` a row has asked for, newest last. */
const asked: Array<boolean | null | undefined> = [];
mock.module("next/link", () => ({
  default: ({ prefetch, children, ...rest }: { prefetch?: boolean | null; children?: React.ReactNode; href: string }) => {
    asked.push(prefetch);
    return <a {...rest}>{children}</a>;
  },
}));
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * A HAND-DRIVEN IntersectionObserver. happy-dom has none, and a real one would
 * make this a test of layout rather than of the cap: what is being pinned is
 * what the row does WHEN it is told it is near the viewport, and when it is
 * told it has left.
 */
type Watcher = { target: Element; fire: (isIntersecting: boolean) => void; margin?: string };
const watchers: Watcher[] = [];
class FakeObserver {
  constructor(
    private readonly callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
    private readonly options?: { rootMargin?: string },
  ) {}
  observe(target: Element) {
    watchers.push({
      target,
      ...(this.options?.rootMargin === undefined ? {} : { margin: this.options.rootMargin }),
      fire: (isIntersecting: boolean) => this.callback([{ isIntersecting, target }]),
    });
  }
  disconnect() {}
  unobserve() {}
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;

const { SessionRow } = await import("./session-row");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { PREFETCH_INTENT_MS, PREFETCH_MARGIN, resetPrefetch, warmedRows } = await import("@/lib/rail-prefetch");
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarSession } from "@/lib/session-list";

/** No usage figures, so the row takes the plain branch rather than the hover
 *  card — see `hasFigures`. The prefetch decision is identical in both. */
const session = (over: Partial<SidebarSession> = {}): SidebarSession =>
  ({
    id: "session_1",
    title: "Exoplanets",
    createdAt: 1,
    updatedAt: 2,
    driver: "claude",
    projectId: "project_1",
    projectName: "exoplanets",
    activity: "idle",
    ...over,
  }) as SidebarSession;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
/** Every URL the row put on the wire, so a warm-up can be told from a claim. */
let fetched: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetPrefetch();
  asked.length = 0;
  watchers.length = 0;
  fetched = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return Response.json({ session: { id: "session_1" }, turns: [], items: [], tasks: [], requests: [], cursor: 1, events: [], subscriptions: [] });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function mount(over: Partial<SidebarSession> = {}, active = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SidebarProvider>
        <SessionRow session={session(over)} active={active} showProject={false} renderedAt={10} onRowChanged={() => {}} />
      </SidebarProvider>,
    );
  });
  return host.querySelector(".group\\/session") as HTMLElement;
}

/** The pause that separates intent from a pointer crossing the rail. */
async function rest(ms: number) {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * A POINTER ARRIVING AND LEAVING, IN THE EVENTS REACT ACTUALLY LISTENS FOR.
 *
 * `onPointerEnter` is not a DOM event React subscribes to — enter and leave do
 * not bubble, so React synthesises them at the root from `pointerover` and
 * `pointerout`. Dispatching a literal `pointerenter` reaches nothing, silently,
 * and a test that did it would pass by warming nothing at all.
 */
async function pointer(row: HTMLElement, type: "pointerover" | "pointerout") {
  await act(async () => {
    row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

describe("a rail row at rest", () => {
  test("is cold, and asks for nothing by being drawn", () => {
    /**
     * THE DEFAULT THAT MUST NOT DRIFT. The rail draws every session on this
     * Mac; a row that warmed on sight would make a list of forty rows forty
     * route payloads and forty `/bootstrap` reads for the one conversation
     * somebody opens. Static, because "on sight" means before any effect runs.
     */
    renderToStaticMarkup(
      <SidebarProvider>
        <SessionRow session={session()} active={false} showProject={false} renderedAt={10} onRowChanged={() => {}} />
      </SidebarProvider>,
    );
    expect(asked).toEqual([false]);
    expect(warmedRows()).toEqual([]);
  });

  test("a row with no project is never warmed — it has no address to warm", async () => {
    // `sessionHref` sends it to the front door, which is not where this row
    // leads. Warming that would be warming somebody else's route.
    await mount({ projectId: undefined });
    expect(watchers).toHaveLength(0);
    expect(warmedRows()).toEqual([]);
  });
});

describe("a row near the viewport", () => {
  test("is watched at t3's 160px margin", async () => {
    await mount();
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.margin).toBe(PREFETCH_MARGIN);
    expect(PREFETCH_MARGIN).toBe("160px");
  });

  test("warms when it arrives, and gives the slot back when it leaves", async () => {
    await mount();
    await act(async () => watchers[0]!.fire(true));
    expect(asked.at(-1)).toBeNull();
    expect(warmedRows()).toEqual(["session_1"]);
    // …and it paid its own `/bootstrap`, which is the read the click would
    // otherwise have waited for.
    expect(fetched.some((url) => url.includes("/api/sessions/session_1/bootstrap"))).toBe(true);

    await act(async () => watchers[0]!.fire(false));
    expect(asked.at(-1)).toBe(false);
    expect(warmedRows()).toEqual([]);
  });

  test("the active row warms its route but never re-reads its own transcript", async () => {
    // The cockpit is already holding that connection and tailing it once a
    // second; a second caller asking for it would be work nobody needs.
    await mount({ id: "session_active" }, true);
    await act(async () => watchers[0]!.fire(true));
    expect(warmedRows()).toEqual(["session_active"]);
    expect(fetched).toEqual([]);
  });
});

describe("a row you are pointing at", () => {
  test("warms after the pause, not before it", async () => {
    const row = await mount({ id: "session_hover" });
    await pointer(row, "pointerover");
    // A POINTER SWEEPING ACROSS THE RAIL MUST WARM NOTHING. Below the pause,
    // this row is still cold.
    await rest(PREFETCH_INTENT_MS - 100);
    expect(warmedRows()).toEqual([]);
    await rest(120);
    expect(warmedRows()).toEqual(["session_hover"]);
    expect(asked.at(-1)).toBeNull();
    expect(fetched.some((url) => url.includes("/api/sessions/session_hover/bootstrap"))).toBe(true);
  });

  test("leaving before the pause elapses cancels it", async () => {
    const row = await mount({ id: "session_swept" });
    await pointer(row, "pointerover");
    await rest(40);
    await pointer(row, "pointerout");
    await rest(PREFETCH_INTENT_MS + 80);
    expect(warmedRows()).toEqual([]);
    expect(fetched).toEqual([]);
  });
});
