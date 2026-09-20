"use client";

/**
 * The transcript's SCROLL LAYER, and nothing else.
 *
 * A thin wrapper around use-stick-to-bottom that owns the viewport, its content
 * wrapper and its scroll-to-bottom button. It knows nothing about turns, items,
 * sessions or the engine — the conversation renderer configures it.
 *
 * "Stick to bottom" rather than "scroll on every append": the viewport follows
 * new content only while the reader is ALREADY at the bottom. Scrolling up to
 * read something during a long turn must not be undone by the next token.
 *
 * OPENING A CONVERSATION IS NOT GROWTH, and the library cannot tell the two
 * apart by itself. `initial="instant"` reaches exactly ONE resize: the library
 * keeps `previousHeight` per content ELEMENT, and picks `initial` only while it
 * is still undefined (use-stick-to-bottom 1.1.6, useStickToBottom.js ~330) — so
 * "the first placement is instant" holds only on a freshly mounted element that
 * receives its whole transcript in one go. A cockpit that stays mounted while
 * the route moves from one session to the next gets neither: the element is the
 * same one, and the transcript arrives in up to three steps (the previous
 * session's rows are still in state, then the cached photograph, then the live
 * read). Every step after the first was `resize="smooth"` — a spring animation
 * from wherever the scrollbar had been clamped to, i.e. the long crawl down
 * from the top that this file's comment used to claim was impossible.
 *
 * So the caller names the conversation on screen and says whether its own
 * transcript has landed yet, and until it has, EVERY placement is instant —
 * the ones React commits (below) and the ones the library observes for itself
 * (`resize`). Only growth after that — a streaming answer under a reader who
 * is already at the bottom — animates.
 *
 * TWO MORE THINGS THE LIBRARY CANNOT DO FOR ITSELF, added here:
 *
 *   • It drops its lock for reasons that are not a reader's decision, and
 *     growth alone never restores it — see lib/scroll-follow.ts for the whole
 *     mechanism. `ConversationFollow` undoes the escapes nobody asked for and
 *     leaves the ones the reader performed.
 *   • Sending a message must ALWAYS land at the end, whatever the lock says.
 *     That one is the caller's moment rather than a rule this file could infer,
 *     so it arrives through `followRef`.
 *   • Reaching the TOP edge is a gesture too, and paging history in there moves
 *     everything the reader was looking at down by the height of what arrived.
 *     `ConversationTopEdge` owns both halves — see it for the argument.
 */

import type { ComponentProps, ReactNode, Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowDownIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { shouldRefollow } from "@/lib/scroll-follow";
import { cn } from "@/lib/utils";

/** What a caller can ask the scroll layer to do from outside a render. */
export type ConversationFollowHandle = {
  /** Put the viewport at the end and follow again, whatever the lock says. */
  toBottom: () => void;
};

/**
 * The gestures that mean the READER moved this viewport.
 *
 * Pointer events on the scroll element itself, so a mousedown in the composer
 * or a wheel over the sidebar is not mistaken for one. `wheel` covers trackpad
 * and mouse, `touchmove` the drag on a touchscreen, `mousedown` both the
 * scrollbar and a text selection begun inside the transcript — the last is the
 * one the library reads as `isSelecting()`.
 */
const READER_GESTURES = ["wheel", "touchmove", "mousedown"] as const;

/**
 * Undoes the escapes nobody performed.
 *
 * Renders nothing; it exists to be INSIDE the provider, which is the only place
 * the scroll state can be reached from. It acts on the EDGE — the commit where
 * `escapedFromLock` becomes true — because that is the one moment where the
 * question is answerable: either a gesture landed a few milliseconds ago and
 * the escape is the reader's, or none did and it is the library's own spring,
 * wheel rebound or stale selection.
 */
const ConversationFollow = ({ handle }: { handle?: Ref<ConversationFollowHandle> }) => {
  const { escapedFromLock, scrollToBottom, scrollRef, state } = useStickToBottomContext();
  const gestureAt = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const mark = () => {
      gestureAt.current = performance.now();
    };
    for (const kind of READER_GESTURES) element.addEventListener(kind, mark, { passive: true });
    return () => {
      for (const kind of READER_GESTURES) element.removeEventListener(kind, mark);
    };
  }, [scrollRef]);

  useImperativeHandle(
    handle,
    () => ({
      toBottom: () => {
        // A send is not a gesture the reader made against this viewport, and
        // leaving the stamp behind would make the next spurious escape look
        // like theirs. Clearing it is part of arriving at the end.
        gestureAt.current = Number.NEGATIVE_INFINITY;
        void scrollToBottom({ animation: "instant" });
      },
    }),
    [scrollToBottom],
  );

  useEffect(() => {
    if (!shouldRefollow({ escaped: escapedFromLock, distance: state.scrollDifference, gestureAgo: performance.now() - gestureAt.current })) {
      return;
    }
    // Re-arms `isAtBottom` (useStickToBottom.js ~135-137), which is the flag
    // the follow animation actually gates on (~153-156). `escapedFromLock` is
    // NOT cleared by this — the library has no API for it — but nothing reads
    // that flag except its own re-arm branch, so following resumes regardless.
    void scrollToBottom({ animation: "instant" });
  }, [escapedFromLock, scrollToBottom, state]);

  return null;
};

/**
 * The placement rule, as a decision rather than an effect — so the sequence a
 * session switch produces can be tested without a browser.
 *
 * `settledAt` is the conversation this viewport has finished opening. While it
 * disagrees with `at`, the viewport is still being OPENED and every commit must
 * put it at the end without animating, however many commits that takes. It is
 * recorded only once `landed` says the live transcript has arrived: settling on
 * the cached photograph would leave the live read that grows past it to animate,
 * which is the second half of the same bug. Settling on a read that FAILED is
 * deliberate too — a conversation pinned to its end forever is one the reader
 * can never scroll up in.
 */
export function nextPlacement(
  at: string,
  landed: boolean,
  settledAt: string | undefined,
): { place: boolean; settledAt: string | undefined } {
  if (settledAt === at) return { place: false, settledAt };
  return { place: true, settledAt: landed ? at : settledAt };
}

/**
 * Puts the viewport at the end of a conversation that is still opening.
 *
 * Renders nothing; it exists to be INSIDE the provider, which is the only place
 * the scroll state can be reached from. The effect deliberately has no
 * dependency array: any commit at all can be the one that grows the transcript,
 * and `nextPlacement` is the guard — once the conversation has settled this
 * returns before touching the DOM.
 */
const ConversationPlacement = ({ at, landed }: { at: string; landed: boolean }) => {
  const { scrollToBottom } = useStickToBottomContext();
  const settledAt = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const next = nextPlacement(at, landed, settledAt.current);
    settledAt.current = next.settledAt;
    if (!next.place) return;
    // Asked for from the LAYOUT phase, so the scroll is queued before the
    // browser gets to paint the commit that grew the transcript. The hook does
    // the move itself on the next animation frame, which is the same frame —
    // rendering runs animation callbacks before it paints — and it also re-locks
    // `isAtBottom`, so a switch made from halfway up the previous session lands
    // at the end of this one AND follows it afterwards.
    void scrollToBottom({ animation: "instant" });
  });
  return null;
};

/**
 * How far above the top edge a page of history starts loading.
 *
 * Far enough that an unhurried scroll never reaches a wall, near enough that a
 * reader who opens a long conversation and stays at the bottom pays for
 * nothing. Roughly half a viewport on a laptop.
 */
const PREFETCH_MARGIN_PX = 400;

/**
 * WHERE THE VIEWPORT MUST SIT once a page of older turns has been prepended.
 *
 * Prepending moves every pixel the reader was looking at DOWN by exactly the
 * height of what arrived, and nothing in the browser puts it back: CSS scroll
 * anchoring is best-effort and a flex column under a scroll library is not the
 * case it handles well. The height that arrived is the growth in `scrollHeight`
 * — which is why the measurement is taken before the request rather than
 * inferred from the turns that came back, whose heights nobody knows until
 * they are laid out.
 */
export function anchoredScrollTop(before: { scrollTop: number; scrollHeight: number }, after: { scrollHeight: number }): number {
  return before.scrollTop + (after.scrollHeight - before.scrollHeight);
}

/**
 * THE TOP OF THE TRANSCRIPT, AS A TRIGGER (#498).
 *
 * History used to be an explicit press, on the argument that reaching the top
 * of the window to re-read something must stay free. That argument was about
 * FETCHING — and it is still honoured, because nothing is fetched unless there
 * is a page above and none is already in flight. What it cost was the reading:
 * scrolling up in a long session hit a wall with a button on it, once per
 * twenty turns.
 *
 * THE BUTTON STAYS, as `children`. An `IntersectionObserver` is a gesture only a
 * pointer or a scrolling keystroke performs; a reader who tabs through the
 * conversation needs a control to focus, and that is the same control it always
 * was doing the same thing.
 *
 * MOUNT IT UNCONDITIONALLY — it decides for itself whether to draw anything.
 * The LAST page arrives in the same commit that turns `more` off, so a caller
 * that mounted this on `more` would unmount it exactly when its correction was
 * due, and the one page where a reader has walked furthest back is the one whose
 * place gets thrown away.
 *
 * Renders inside the provider, which is the only place the scroll element can
 * be reached from.
 */
export const ConversationTopEdge = ({
  more,
  loading,
  onReach,
  children,
}: {
  /** There is at least one page of history above what is loaded. */
  more: boolean;
  /** A page is already on its way. */
  loading: boolean;
  /** Fetch the next page. Called at most once per arrival at the edge. */
  onReach: () => void;
  /** The same gesture as a control — the keyboard's way in. */
  children?: ReactNode;
}) => {
  const { scrollRef } = useStickToBottomContext();
  const edge = useRef<HTMLDivElement>(null);
  /** Where the viewport was when the page was asked for. */
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | undefined>(undefined);
  /** Whether the request this anchor belongs to has been seen in flight. */
  const awaited = useRef(false);

  useEffect(() => {
    const root = scrollRef.current;
    const target = edge.current;
    // No page above, or one already coming: nothing to watch for. Tearing the
    // observer down while a fetch is in flight is also what keeps one arrival
    // at the edge from becoming four requests.
    if (!root || !target || !more || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const element = scrollRef.current;
        if (element) anchor.current = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
        onReach();
      },
      { root, rootMargin: `${PREFETCH_MARGIN_PX}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollRef, more, loading, onReach]);

  /**
   * DELIBERATELY NO DEPENDENCY ARRAY, and a layout effect rather than an effect:
   * any commit at all can be the one that prepends the page — the growth and the
   * `loading` flag land in separate commits — and the correction has to be
   * queued before the browser paints, or the reader sees the jump this exists to
   * prevent.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const held = anchor.current;
    if (!element || !held) return;
    if (element.scrollHeight > held.scrollHeight) {
      anchor.current = undefined;
      awaited.current = false;
      element.scrollTop = anchoredScrollTop(held, element);
      return;
    }
    if (loading) {
      awaited.current = true;
      return;
    }
    // The request ended and prepended nothing — it failed, or the page was
    // empty. Drop the anchor: left behind, it would move the viewport on
    // whatever grew the transcript next.
    if (awaited.current) {
      anchor.current = undefined;
      awaited.current = false;
    }
  });

  // Nothing to draw once the whole conversation is loaded — but the COMPONENT
  // is still mounted, which is what keeps the correction above alive through
  // the commit that turned `more` off.
  if (!more && !loading) return null;
  return (
    <div>
      <div ref={edge} aria-hidden data-conversation-top-edge="" />
      {children}
    </div>
  );
};

export type ConversationViewportProps = ComponentProps<typeof StickToBottom> & {
  /** WHICH conversation is on screen. A change re-opens the viewport on it. */
  conversation?: string;
  /** Whether `conversation`'s own transcript has arrived (or failed to). */
  landed?: boolean;
  /** Lets a caller put the viewport back at the end on its own events —
   *  sending a message, above all. */
  followRef?: Ref<ConversationFollowHandle>;
};

export const ConversationViewport = ({
  className,
  conversation,
  landed = true,
  followRef,
  children,
  ...props
}: ConversationViewportProps) => {
  // LAST, so their effects run after the transcript's own: React flushes each
  // phase in tree order, and a measurement taken before a sibling subtree has
  // settled is a measurement of the wrong height.
  const placement = conversation === undefined ? null : <ConversationPlacement at={conversation} landed={landed} />;
  const follow = useMemo(() => <ConversationFollow {...(followRef ? { handle: followRef } : {})} />, [followRef]);
  const compose = (rendered: ReactNode) => (
    <>
      {rendered}
      {placement}
      {follow}
    </>
  );
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial="instant"
      // Growth the library notices on its own — an image decoding, a code block
      // finishing its highlighting — is part of the OPENING until the transcript
      // has landed, and no React commit accompanies it for the effect above to
      // catch.
      resize={landed ? "smooth" : "instant"}
      role="log"
      {...props}
    >
      {typeof children === "function" ? (context) => compose(children(context)) : compose(children)}
    </StickToBottom>
  );
};

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    // `py-*`/`px-*` rather than the `p-*` shorthand, so a caller can override
    // just the horizontal half. tailwind-merge only resolves SAME-AXIS
    // conflicts, so a shorthand `p-4` would survive alongside a later `px-0`
    // instead of being replaced by it.
    className={cn("flex flex-col gap-8 py-6 px-4", className)}
    {...props}
  />
);

export const ConversationScrollButton = ({ className, ...props }: ComponentProps<typeof Button>) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const onClick = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;
  return (
    <Button
      className={cn(
        "absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-2 dark:bg-background dark:hover:bg-muted",
        className,
      )}
      onClick={onClick}
      size="icon"
      type="button"
      variant="outline"
      aria-label="Jump to the newest message"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
};
