"use client";

/**
 * ONE FRAME FOR EVERYTHING MONOSPACE THAT IS NOT A FILE.
 *
 * Tool output, an approval's argument, a diff, a fenced block in an answer —
 * five call sites had five slightly different `<pre>` recipes, and the reader
 * saw five products. This is the one recipe: a single hairline, the muted
 * fill, ten pixels of padding, and nothing above the text unless something
 * has to be there. Streamdown's fenced blocks get the same tokens from
 * globals.css (`[data-streamdown="code-block"]`) rather than from here, so
 * the two stay one system without this file wrapping a library.
 *
 * TWO READING NEEDS, ONE SURFACE. Source is read as written — no forced wrap,
 * horizontal scroll — because a wrapped line of code is a different program.
 * Output is skimmed — wrapped, so a long command line does not hide behind a
 * scrollbar. `wrap` chooses; the frame does not change.
 *
 * LONG OUTPUT IS CUT AT 24 LINES, NOT SCROLLED IN PLACE. A scroll box inside a
 * scrolling transcript is the thing people fight with a trackpad; a fold with
 * a plain "Show all · N lines" is not. Nothing is truncated in storage: the
 * text is sliced for display only, and COPY ALWAYS COPIES EVERYTHING.
 *
 * COPY IS A BUTTON, not a hover reveal: it takes keyboard focus, has a label,
 * and is large enough for a thumb — on a phone there is no hover to reveal it.
 */
import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const CODE_SURFACE_LINES = 24;

export const CODE_SURFACE_FRAME = "rounded-md border border-border/70 bg-muted/40";
export const CODE_SURFACE_TEXT = "font-mono text-2xs leading-relaxed";

/** The first `limit` lines, and how many were held back. Split on `\n` only
 *  so a CRLF output keeps its bytes; the count is what the fold names. */
export function foldLines(text: string, limit = CODE_SURFACE_LINES): { shown: string; hidden: number; total: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { shown: text, hidden: 0, total: lines.length };
  return { shown: lines.slice(0, limit).join("\n"), hidden: lines.length - limit, total: lines.length };
}

const COPY_LABEL = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = useState<keyof typeof COPY_LABEL>("idle");
  const timer = useRef<number>(undefined);
  // A feedback timer must not fire into an unmounted button.
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const settle = (next: "copied" | "failed") => {
    setState(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1_500);
  };
  return (
    <button
      type="button"
      aria-label={COPY_LABEL[state]}
      title={COPY_LABEL[state]}
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      onClick={() => {
        // The clipboard can refuse (no gesture, no permission, an insecure
        // origin the shim could not cover); a refusal is shown, not swallowed.
        navigator.clipboard.writeText(text).then(
          () => settle("copied"),
          () => settle("failed"),
        );
      }}
    >
      {state === "copied" ? <CheckIcon className="size-3.5 text-success" /> : state === "failed" ? <XIcon className="size-3.5 text-destructive" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

export function CodeSurface({
  text,
  wrap = false,
  fold = true,
  tone = "muted",
  className,
  children,
}: {
  /** The whole content. Never sliced by the caller — the fold and the copy
   *  both need all of it. */
  text: string;
  /** Output wraps; source does not. */
  wrap?: boolean;
  /** Cut at 24 lines behind "Show all". Off for content that must be read whole. */
  fold?: boolean;
  tone?: "muted" | "foreground";
  className?: string;
  /** Pre-rendered lines (a diff's tinted rows). When present, `text` is
   *  still what copy writes; the fold applies to `text`'s line count and the
   *  caller is expected to render the same lines. */
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = fold && !expanded ? foldLines(text) : { shown: text, hidden: 0, total: text.split("\n").length };
  return (
    // `pr-8` on the FRAME, not the <pre>: the pre scrolls horizontally for
    // source, so padding on it scrolls away and the first line runs under the
    // button. A column on the non-scrolling frame stays put.
    <div className={cn("group/code relative pr-8", CODE_SURFACE_FRAME, className)}>
      <CopyButton text={text} className="absolute top-1 right-1 z-10 bg-muted/60" />
      <pre
        className={cn(
          "overflow-x-auto px-2.5 py-2",
          CODE_SURFACE_TEXT,
          wrap && "break-words whitespace-pre-wrap",
          tone === "muted" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {children ?? folded.shown}
      </pre>
      {fold && folded.total > CODE_SURFACE_LINES && (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex w-full items-center border-t border-border/70 px-2.5 py-1 text-left text-2xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : `Show all · ${folded.total} lines`}
        </button>
      )}
    </div>
  );
}
