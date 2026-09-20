/**
 * #498 — PAGING HISTORY IN DOES NOT MOVE WHAT THE READER IS LOOKING AT.
 *
 * Prepending twenty turns pushes every pixel below them DOWN by the height of
 * what arrived. Nothing in the browser reliably puts it back — CSS scroll
 * anchoring is best-effort, and a flex column inside a scroll library is not the
 * case it handles well — so a reader who scrolls to the top of a long session
 * gets their place thrown away at exactly the moment they asked for more of it.
 *
 * THE LAYOUT IS STUBBED, because happy-dom has none: `scrollHeight` is a
 * configurable getter on `Element`, so the test owns it outright and can say
 * "the page that arrived was 3 000 pixels tall" without laying anything out.
 * `scrollTop` is a real read/write accessor and is left alone — it is the thing
 * under test.
 *
 * THE OBSERVER IS STUBBED TOO, and fired by hand. happy-dom ships an
 * `IntersectionObserver` that never reports anything, which would make every
 * assertion below vacuous; this one records its callback so the test can say
 * exactly when the reader reached the top edge.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { anchoredScrollTop, ConversationContent, ConversationTopEdge, ConversationViewport } from "./conversation";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The observers the tree has opened, newest last. */
let observers: FakeObserver[] = [];

class FakeObserver {
  targets: Element[] = [];
  constructor(
    readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void,
    readonly options: { root?: Element | null; rootMargin?: string } = {},
  ) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((other) => other !== this);
  }
  takeRecords() {
    return [];
  }
  /** The reader arrived at the top edge. */
  reach() {
    this.callback(this.targets.map((target) => ({ target, isIntersecting: true })));
  }
}

const realObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  observers = [];
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = realObserver;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * A conversation with a page of history above it, and a scroll element whose
 * height the test dictates.
 *
 * Returns the handles a reader's gestures are expressed through: where the
 * viewport sits, how tall the transcript is, and the edge observer.
 */
async function openConversation({ startingHeight = 8_000, startingTop = 120 } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);

  const reached: number[] = [];
  let scrollHeight = startingHeight;
  let loading = false;
  let more = true;
  const context: { current: StickToBottomContext | null } = { current: null };

  const tree = () => (
    <ConversationViewport
      conversation="session_1"
      landed
      // `StickToBottom` hands its whole context back through this, which is how
      // the test reaches the exact element the component will be adjusting.
      contextRef={context}
    >
      <ConversationContent>
        <ConversationTopEdge
          more={more}
          loading={loading}
          onReach={() => {
            reached.push(scrollHeight);
          }}
        >
          <button type="button">Load earlier turns</button>
        </ConversationTopEdge>
        <p>a turn</p>
      </ConversationContent>
    </ConversationViewport>
  );

  await act(async () => {
    root.render(tree());
  });

  const scroller = context.current!.scrollRef.current!;
  Object.defineProperty(scroller, "scrollHeight", { get: () => scrollHeight, configurable: true });
  Object.defineProperty(scroller, "clientHeight", { get: () => 800, configurable: true });
  scroller.scrollTop = startingTop;

  return {
    scroller,
    reached,
    /** The edge's own observer — the last one the tree opened. */
    edge: () => observers.at(-1)!,
    /** Re-render with a new `loading`, and optionally a transcript that grew.
     *  `more: false` is the LAST page — the one that arrives in the same commit
     *  that says there is no more history. */
    async settle(next: { loading: boolean; grewBy?: number; more?: boolean }) {
      loading = next.loading;
      if (next.more !== undefined) more = next.more;
      if (next.grewBy) scrollHeight += next.grewBy;
      await act(async () => {
        root.render(tree());
      });
    },
  };
}

describe("reaching the top edge of a conversation", () => {
  test("asks for the next page", async () => {
    const view = await openConversation();
    expect(view.reached).toHaveLength(0);
    view.edge().reach();
    expect(view.reached).toHaveLength(1);
  });

  test("watches the scroll element, with a margin so the page starts before the wall", async () => {
    const view = await openConversation();
    const edge = view.edge();
    expect(edge.options.root).toBe(view.scroller);
    expect(edge.options.rootMargin).toBe("400px 0px 0px 0px");
  });

  test("puts the viewport back by exactly the height that was prepended", async () => {
    const view = await openConversation({ startingHeight: 8_000, startingTop: 120 });
    view.edge().reach();
    // The request is in flight; nothing has arrived and nothing has moved.
    await view.settle({ loading: true });
    expect(view.scroller.scrollTop).toBe(120);

    // Twenty turns land above the reader: 3 000 pixels of them. The growth and
    // the flag arrive in separate commits, exactly as the cockpit produces them.
    await view.settle({ loading: true, grewBy: 3_000 });
    expect(view.scroller.scrollTop).toBe(3_120);
    await view.settle({ loading: false });
    expect(view.scroller.scrollTop).toBe(3_120);
  });

  test("does not move the viewport when the page brought nothing", async () => {
    const view = await openConversation({ startingTop: 120 });
    view.edge().reach();
    await view.settle({ loading: true });
    // The request failed, or the page was empty. The anchor is dropped rather
    // than left to fire on whatever grows the transcript next.
    await view.settle({ loading: false });
    expect(view.scroller.scrollTop).toBe(120);

    // …and that next growth is a streaming answer at the BOTTOM, which must not
    // drag the reader anywhere.
    await view.settle({ loading: false, grewBy: 500 });
    expect(view.scroller.scrollTop).toBe(120);
  });

  test("holds the reader's place on the LAST page, which lands as the button leaves", async () => {
    // The final page arrives in the same commit that says there is no more
    // history. Mounted on `more`, this component would unmount in exactly that
    // commit — and the one page a reader has walked furthest to reach is the one
    // whose place gets lost.
    const view = await openConversation({ startingHeight: 8_000, startingTop: 90 });
    view.edge().reach();
    await view.settle({ loading: true });
    await view.settle({ loading: false, more: false, grewBy: 2_400 });
    expect(view.scroller.scrollTop).toBe(2_490);
    // Nothing is drawn any more: no sentinel, and no button.
    expect(document.body.textContent).not.toContain("Load earlier turns");
  });

  test("one arrival at the edge is one request, however long the page takes", async () => {
    const view = await openConversation();
    const edge = view.edge();
    edge.reach();
    edge.reach();
    edge.reach();
    // The observer is torn down for the duration of the flight, so the reader
    // sitting at the top does not turn one page into four.
    await view.settle({ loading: true });
    expect(observers).toHaveLength(0);
    expect(view.reached).toHaveLength(3);
  });
});

describe("the arithmetic on its own", () => {
  test("is the growth in scroll height, added to where the reader was", () => {
    expect(anchoredScrollTop({ scrollTop: 120, scrollHeight: 8_000 }, { scrollHeight: 11_000 })).toBe(3_120);
  });

  test("leaves a reader at the very top pinned to the new top of the page", () => {
    expect(anchoredScrollTop({ scrollTop: 0, scrollHeight: 8_000 }, { scrollHeight: 11_000 })).toBe(3_000);
  });
});
