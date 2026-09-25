"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import { useStreamingReveal } from "@/lib/use-streaming-reveal";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { math } from "@streamdown/math";
import { cn } from "@/lib/utils";
import { useLinkPolicy } from "@/lib/link-policy";
import { rehypeDisplayStandaloneMath } from "@/lib/markdown-math";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";

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
 * MATH IS THE LIBRARY'S OWN PLUGIN, NOT A LOCAL PIPELINE.
 *
 * `@streamdown/math` is Streamdown's supported math integration — remark-math
 * for the syntax, rehype-katex + KaTeX for the typesetting — and Streamdown
 * appends it AFTER its sanitising defaults (`rehype-harden`), so the KaTeX
 * markup is produced from text that has already been through the filter rather
 * than smuggled past it. Its two defaults are the ones we want and neither is
 * ours to relax:
 *
 *   • `singleDollarTextMath: false` — `$5` and `$10` in a sentence stay money.
 *     Turning it on makes any two dollar signs in a paragraph an equation.
 *   • KaTeX `trust: false` / `strict: "warn"` — `\href`, `\htmlClass` and the
 *     rest of the HTML extension are refused and printed as their own names in
 *     the muted colour, so TeX arriving from a model cannot mint a link or set
 *     an attribute. Nothing here passes `trust`.
 *
 * A failed equation renders its own source in `--color-muted-foreground` (the
 * plugin's `errorColor` default) instead of throwing, which is what makes a
 * half-streamed `$$\frac{1}{` a quiet grey fragment rather than a crashed
 * transcript.
 *
 * The stylesheet is `katex/dist/katex.min.css`, imported once in `app/layout.tsx`
 * ahead of `globals.css` — the fonts have to be resolved by the bundler, and the
 * app's own rules for overflow and colour have to come after it.
 */
const MATH_PLUGINS = { math } as const;
const MATH_REHYPE = [rehypeDisplayStandaloneMath];

/**
 * LINKS ARE LINKS WHEN THE COCKPIT KEEPS THEM (Settings → Links).
 *
 * Streamdown's default draws a link as a `<button>` behind its own "open this
 * link?" dialog, then `window.open`s it — no `href` for the cockpit's click
 * handler to read, and a dialog in front of every click. That is why the
 * setting never took: with it on, the destination is a tab in the session's
 * own browser, with its address in view, so the gate has nothing left to
 * guard and a plain anchor lets the click be routed. Off, the gate stays.
 */
const LINKS_UNGATED = { enabled: false } as const;

/**
 * Markdown that tolerates being half-written.
 *
 * `parseIncompleteMarkdown` is what keeps a streaming answer from flickering
 * between raw asterisks and rendered bold as tokens land mid-token; it is
 * enabled ONLY while streaming, because on settled text it would happily
 * "complete" markup the author meant literally.
 */
export const MessageResponse = memo(
  ({ className, streaming, children, rehypePlugins, plugins, ...props }: MessageResponseProps & { streaming?: boolean }) => {
    const revealed = useStreamingReveal(typeof children === "string" ? children : "", streaming === true);
    const { openInSessionBrowser } = useLinkPolicy();
    return (
    <Streamdown
      className={cn("telar-markdown w-full text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", STREAMDOWN_LIST_SPACING, className)}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming === true}
      plugins={plugins ? { ...MATH_PLUGINS, ...plugins } : MATH_PLUGINS}
      // Ours first, then the caller's: the promotion reads the tree before
      // rehype-katex consumes it, and a caller adding a plugin must not be able
      // to drop math by shadowing the prop.
      rehypePlugins={rehypePlugins ? [...MATH_REHYPE, ...rehypePlugins] : MATH_REHYPE}
      // Copy stays (a real button — keyboard and touch reach it); download
      // goes: a fenced snippet in an answer is rarely a file, and the file
      // viewer already owns that gesture for things that are.
      controls={{ code: { copy: true, download: false }, table: true, mermaid: true }}
      {...(openInSessionBrowser ? { linkSafety: LINKS_UNGATED } : {})}
      {...props}
    >
      {typeof children === "string" ? revealed : children}
    </Streamdown>
  ); },
  (prev, next) => prev.children === next.children && prev.streaming === next.streaming,
);

MessageResponse.displayName = "MessageResponse";

/**
 * MARKDOWN, READ AS A PERSON READS IT.
 *
 * "Copy text" and "Copy as Markdown" are two different answers to "give me
 * this message", and a menu offering both has to actually have both: the
 * source, for pasting into something that renders it, and the prose, for
 * pasting into something that does not — a comment box, a chat, a commit
 * message.
 *
 * DELIBERATELY A SMALL PASS, NOT A PARSER. It unwraps the syntax that is pure
 * noise once the markup is gone — fences, emphasis runs, heading hashes, list
 * bullets, blockquote markers, link chrome — and touches nothing else. It does
 * not reflow, renumber, or render tables, because a lossy "plain text" that
 * rearranged the author's lines would be worse at the one job it has. What
 * comes out is the same text with its punctuation removed.
 *
 * A FENCE'S CONTENTS SURVIVE, only its ``` lines go: a code block is the part
 * of an answer people most often want on the clipboard, and stripping the
 * asterisks inside one would corrupt it — so emphasis is unwrapped OUTSIDE
 * fenced blocks only.
 */
export function messagePlainText(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return null;
      }
      if (fenced) return line;
      return line
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        .replace(/^(\s*)>\s?/, "$1")
        .replace(/^(\s*)[-*+]\s+/, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(\*|_)(.+?)\1/g, "$2");
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .trim();
}

/** A quote, the way a person types one: every line prefixed, blanks included,
 *  so the block survives being pasted in the middle of a draft. */
export function quoteForComposer(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * A MESSAGE'S OWN MENU — the three things anybody wants from a message they are
 * looking at, and nothing that writes.
 *
 * NOT A SECOND COPY BUTTON: the reading lane has no per-message copy control at
 * all (only fenced code blocks do, through Streamdown's own), so this is the
 * first way to take a whole answer, and it offers both forms rather than
 * guessing which one you meant.
 *
 * QUOTE INTO COMPOSER IS THE ONE THAT CHANGES ANYTHING, and what it changes is
 * a draft — the same `insertIntoComposer` a panel row's "Insert as reference"
 * reaches, so a quote and a reference land the same way and neither resolves
 * anything behind the reader's back.
 *
 * `items` is how a surface adds the verb only IT has — the transcript's agent
 * row and its "Open in the Agents panel" — without this component learning
 * about sub-agents.
 */
export function MessageMenu({
  text,
  markdown = true,
  onQuote,
  items,
  children,
}: {
  /** The message's own source. Markdown for an assistant turn, plain for a
   *  person's; `markdown` says which, and hides the item that would otherwise
   *  offer the same string twice. */
  text: string;
  markdown?: boolean;
  onQuote?: (text: string) => void;
  /** Extra rows, below a separator — a surface's own verbs. */
  items?: React.ReactNode;
  children: React.ReactNode;
}) {
  const body = text.trim();
  if (!body) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(markdown ? messagePlainText(body) : body)}>Copy text</ContextMenuItem>
        {markdown && <ContextMenuItem onClick={() => void navigator.clipboard.writeText(body)}>Copy as Markdown</ContextMenuItem>}
        {onQuote && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onQuote(quoteForComposer(body))}>Quote into composer</ContextMenuItem>
          </>
        )}
        {items && (
          <>
            <ContextMenuSeparator />
            {items}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
