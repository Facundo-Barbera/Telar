"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

/**
 * The reading lane, and who gets a bubble.
 *
 * ONLY THE USER GETS A BUBBLE. An assistant turn owns the full measure with no
 * fill and no border; the human's message is a compact `bg-secondary` bubble
 * shrunk to its own content and pushed right. Giving both a bubble doubles the
 * chrome and makes a long transcript read as two columns of boxes rather than
 * as a conversation.
 *
 * ASSISTANT CONTENT IS `w-full`, NOT `w-fit`. This is not cosmetic: every nested
 * activity row lives inside this box, so a `w-fit` assistant turn makes tool
 * disclosures inherit the width of the longest prose fragment in the turn — and
 * they visibly resize as the agent narrates. The lane has to be stable.
 */

export type MessageRole = "user" | "assistant";

export const Message = ({ className, from, ...props }: HTMLAttributes<HTMLDivElement> & { from: MessageRole }) => (
  <div
    // The 50rem measure matches the composer's outer width below it, so prose
    // and the box you type into share one lane.
    className={cn(
      "group mx-auto flex w-full max-w-[50rem] flex-col gap-2",
      from === "user" ? "is-user" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export const MessageContent = ({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-assistant]:w-full group-[.is-user]:w-fit",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3",
      "text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

/**
 * Streamdown renders `ul`/`ol` with `list-inside` but ZERO left padding, so the
 * marker sits flush against the box's own left edge — and every chat surface
 * wraps this in an `overflow-hidden` ancestor, which clips it. Worse, the
 * `list-disc`/`list-decimal` classes Streamdown emits live inside node_modules,
 * which Tailwind's content scan never sees, so those utilities never compile and
 * Preflight's `ol,ul{list-style:none}` wins — markers vanish entirely. Both
 * halves are re-declared here.
 */
const STREAMDOWN_LIST_SPACING = "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/**
 * Markdown that tolerates being half-written.
 *
 * `parseIncompleteMarkdown` is what keeps a streaming answer from flickering
 * between raw asterisks and rendered bold as tokens land mid-token; it is
 * enabled ONLY while streaming, because on settled text it would happily
 * "complete" markup the author meant literally.
 */
export const MessageResponse = memo(
  ({ className, streaming, children, ...props }: MessageResponseProps & { streaming?: boolean }) => (
    <Streamdown
      className={cn("telar-markdown w-full text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", STREAMDOWN_LIST_SPACING, className)}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming === true}
      {...props}
    >
      {children}
    </Streamdown>
  ),
  (prev, next) => prev.children === next.children && prev.streaming === next.streaming,
);

MessageResponse.displayName = "MessageResponse";
