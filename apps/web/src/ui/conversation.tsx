"use client";

import type { ComponentProps, ReactNode, Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { ArrowDownIcon } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/ui/button";
import { shouldRefollow } from "@/ui/scroll-follow";
import { cn } from "@/ui/utils";

export type ConversationFollowHandle = {
  toBottom: () => void;
};

const READER_GESTURES = ["wheel", "touchmove", "mousedown"] as const;

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
    void scrollToBottom({ animation: "instant" });
  }, [escapedFromLock, scrollToBottom, state]);

  return null;
};

export function nextPlacement(
  at: string,
  landed: boolean,
  settledAt: string | undefined,
): { place: boolean; settledAt: string | undefined } {
  if (settledAt === at) return { place: false, settledAt };
  return { place: true, settledAt: landed ? at : settledAt };
}

const ConversationPlacement = ({ at, landed }: { at: string; landed: boolean }) => {
  const { scrollToBottom } = useStickToBottomContext();
  const settledAt = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const next = nextPlacement(at, landed, settledAt.current);
    settledAt.current = next.settledAt;
    if (!next.place) return;
    void scrollToBottom({ animation: "instant" });
  });
  return null;
};

export const READING_BACK_PX = 200;

const ConversationAtBottom = ({ onChange }: { onChange: (atBottom: boolean) => void }) => {
  const { isAtBottom, scrollRef } = useStickToBottomContext();
  const reported = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const report = (atBottom: boolean) => {
      if (reported.current === atBottom) return;
      reported.current = atBottom;
      onChange(atBottom);
    };
    if (isAtBottom) return report(true);
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      if (element.scrollHeight - element.clientHeight - element.scrollTop > READING_BACK_PX) report(false);
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    return () => element.removeEventListener("scroll", measure);
  }, [isAtBottom, onChange, scrollRef]);
  return null;
};

const PREFETCH_MARGIN_PX = 400;

export function anchoredScrollTop(before: { scrollTop: number; scrollHeight: number }, after: { scrollHeight: number }): number {
  return before.scrollTop + (after.scrollHeight - before.scrollHeight);
}

export const ConversationTopEdge = ({
  more,
  loading,
  onReach,
  children,
}: {
  more: boolean;
  loading: boolean;
  onReach: () => void;
  children?: ReactNode;
}) => {
  const { scrollRef } = useStickToBottomContext();
  const edge = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | undefined>(undefined);
  const awaited = useRef(false);

  useEffect(() => {
    const root = scrollRef.current;
    const target = edge.current;
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
    if (awaited.current) {
      anchor.current = undefined;
      awaited.current = false;
    }
  });

  if (!more && !loading) return null;
  return (
    <div>
      <div ref={edge} aria-hidden data-conversation-top-edge="" />
      {children}
    </div>
  );
};

export type ConversationViewportProps = ComponentProps<typeof StickToBottom> & {
  conversation?: string;
  landed?: boolean;
  followRef?: Ref<ConversationFollowHandle>;
  onAtBottomChange?: (atBottom: boolean) => void;
};

export const ConversationViewport = ({
  className,
  conversation,
  landed = true,
  followRef,
  onAtBottomChange,
  children,
  ...props
}: ConversationViewportProps) => {
  const placement = conversation === undefined ? null : <ConversationPlacement at={conversation} landed={landed} />;
  const follow = useMemo(() => <ConversationFollow {...(followRef ? { handle: followRef } : {})} />, [followRef]);
  const compose = (rendered: ReactNode) => (
    <>
      {rendered}
      {placement}
      {follow}
      {onAtBottomChange && <ConversationAtBottom onChange={onAtBottomChange} />}
    </>
  );
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial="instant"
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
