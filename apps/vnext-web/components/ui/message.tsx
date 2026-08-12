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
 * ASSISTANT CONTENT IS `w-full`, NOT `w-fit`. Not cosmetic: every activity row
 * lives inside this box, so a `w-fit` assistant turn makes tool disclosures
 * inherit the width of the longest prose fragment in the turn — and they
 * visibly resize as the agent narrates. The lane has to be stable.
 *
 * THE ROLE IS A PROP, NOT A CLASS ON AN ANCESTOR.
 *
 * The donor styles this by putting `is-user` on the wrapper and reading it from
 * the child with `group-[.is-user]:w-fit`. That worked there and broke here: the
 * utility is composed at runtime from an arbitrary variant, and after a rebuild
 * the `w-fit` and `ml-auto` rules were simply absent from the served stylesheet
 * while their `px-4`/`bg-secondary` siblings survived — so the bubble rendered
 * full-width with correct padding, and nothing failed anywhere. Measured, not
 * guessed: the element matched the selector and no rule set its width.
 *
 * A prop cannot fail that way. It also costs nothing here, because this
 * component is only ever rendered by its own module's `Message` — the class
 * dance exists in the donor because its `MessageContent` is a public slot for
 * callers it does not control.
 */

export type MessageRole = "user" | "assistant";

export const Message = ({ className, from, ...props }: HTMLAttributes<HTMLDivElement> & { from: MessageRole }) => (
  <div
    // The 50rem measure matches the composer's outer width below it, so prose
    // and the box you type into share one lane.
    className={cn("mx-auto flex w-full max-w-[50rem] flex-col gap-2", className)}
    data-role={from}
    {...props}
  />
);

export const MessageContent = ({
  from,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: MessageRole }) => (
  <div
    className={cn(
      "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm text-foreground",
      from === "user"
        ? "ml-auto w-fit rounded-lg bg-secondary px-4 py-3"
        : "w-full",
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
