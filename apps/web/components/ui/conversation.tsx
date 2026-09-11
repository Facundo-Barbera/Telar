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
 */

import type { ComponentProps, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import { ArrowDownIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export type ConversationViewportProps = ComponentProps<typeof StickToBottom> & {
  /** WHICH conversation is on screen. A change re-opens the viewport on it. */
  conversation?: string;
  /** Whether `conversation`'s own transcript has arrived (or failed to). */
  landed?: boolean;
};

export const ConversationViewport = ({
  className,
  conversation,
  landed = true,
  children,
  ...props
}: ConversationViewportProps) => {
  // LAST, so its layout effect runs after the transcript's own: React flushes
  // the layout phase in tree order, and a measurement taken before a sibling
  // subtree has settled is a measurement of the wrong height.
  const placement = conversation === undefined ? null : <ConversationPlacement at={conversation} landed={landed} />;
  const compose = (rendered: ReactNode) => (
    <>
      {rendered}
      {placement}
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
        "absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md dark:bg-background dark:hover:bg-muted",
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
