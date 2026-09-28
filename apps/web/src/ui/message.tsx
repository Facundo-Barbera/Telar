"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import { useStreamingReveal } from "@/ui/hooks/use-streaming-reveal";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { math } from "@streamdown/math";
import { cn } from "@/ui/utils";
import { useLinkPolicy } from "@/platform/link-policy";
import { rehypeDisplayStandaloneMath } from "@/ui/markdown-math";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/ui/context-menu";

export type MessageRole = "user" | "assistant";

export const Message = ({ className, from, ...props }: HTMLAttributes<HTMLDivElement> & { from: MessageRole }) => (
  <div
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

const STREAMDOWN_LIST_SPACING = "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const MATH_PLUGINS = { math } as const;
const MATH_REHYPE = [rehypeDisplayStandaloneMath];

const LINKS_UNGATED = { enabled: false } as const;

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
      rehypePlugins={rehypePlugins ? [...MATH_REHYPE, ...rehypePlugins] : MATH_REHYPE}
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

export function quoteForComposer(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function MessageMenu({
  text,
  markdown = true,
  onQuote,
  items,
  children,
}: {
  text: string;
  markdown?: boolean;
  onQuote?: (text: string) => void;
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
