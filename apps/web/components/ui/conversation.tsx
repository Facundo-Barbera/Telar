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
 * The FIRST placement is instant, not animated. A session opens at its end
 * the way a chat does — an animated scroll from the top through seventy turns
 * was a stall waiting to happen, and on a long transcript it stalled halfway,
 * leaving the reader to finish the trip by hand. Only growth while reading
 * (a streaming answer) animates.
 */

import type { ComponentProps } from "react";
import { useCallback } from "react";
import { ArrowDownIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConversationViewportProps = ComponentProps<typeof StickToBottom>;

export const ConversationViewport = ({ className, ...props }: ConversationViewportProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="instant"
    resize="smooth"
    role="log"
    {...props}
  />
);

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
