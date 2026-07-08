"use client";

import { cn } from "@/lib/utils";
import { cloneElement, isValidElement } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { CodeBlockCopyButton } from "streamdown";

// Streamdown's `code` plugin renders every fenced block through the same
// chrome (rounded wrapper + language-header row + floating copy/download
// toolbar), even when the fence has no language — leaving a ~32px empty
// header and an overlapping toolbar row that doesn't collapse. See
// node_modules/streamdown dist for the "MarkdownCode"/"CodeBlock" internals
// this mirrors (`language-` className match, `data-block` marker convention).
const LANGUAGE_CLASS = /language-([^\s]+)/;

// The single React element react-markdown builds for the nested `<code>`
// node, before it has actually rendered. We only read/clone it, so an
// index-signature prop bag is enough (and keeps cloneElement happy about
// the extra `data-block` marker below).
type CodeElement = ReactElement<Record<string, unknown>>;

const getCodeText = (element: CodeElement): string => {
  const { children } = element.props;
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.filter((child): child is string => typeof child === "string").join("");
  }
  return "";
};

type MarkdownPreProps = ComponentProps<"pre"> & { node?: unknown };

/**
 * Override for Streamdown's `pre` renderer.
 *
 * - Fenced blocks WITH a language keep Streamdown's default rendering
 *   (language header + copy/download toolbar) by cloning the child `code`
 *   element with the same `data-block` marker Streamdown's own `pre`
 *   override uses — zero behavior change for that path.
 * - Bare fences (no language) skip that chrome entirely and render a
 *   compact, bordered, horizontally-scrollable code box with a copy button
 *   that only appears on hover/focus.
 */
export const MarkdownPre = ({ children }: MarkdownPreProps) => {
  if (!isValidElement<Record<string, unknown>>(children)) {
    return <>{children as ReactNode}</>;
  }

  const codeClassName = children.props.className;
  const hasLanguage =
    typeof codeClassName === "string" && LANGUAGE_CLASS.test(codeClassName);

  if (hasLanguage) {
    return cloneElement(children as CodeElement, { "data-block": "true" });
  }

  const code = getCodeText(children as CodeElement).replace(/\n+$/, "");

  return (
    <div
      className="group/code relative my-4 w-full rounded-md border border-border bg-background"
      data-streamdown="bare-code-block"
    >
      {/* Scroll container is separate from the positioned wrapper below so
          the copy button stays pinned to the corner instead of scrolling
          away with wide code. */}
      <div className="overflow-x-auto p-4 text-sm">
        <pre>
          <code className="font-mono">{code}</code>
        </pre>
      </div>
      <div
        className={cn(
          "pointer-events-none absolute top-1.5 right-1.5 opacity-0 transition-opacity",
          "group-hover/code:opacity-100 group-focus-within/code:opacity-100"
        )}
      >
        <div className="pointer-events-auto flex items-center rounded-md border border-sidebar bg-sidebar/80 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur">
          <CodeBlockCopyButton code={code} />
        </div>
      </div>
    </div>
  );
};

MarkdownPre.displayName = "MarkdownPre";
