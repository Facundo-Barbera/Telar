"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { cn } from "@/ui/utils";

export const CODE_SURFACE_LINES = 24;

export const CODE_SURFACE_FRAME = "rounded-md border border-border/70 bg-muted/40";
export const CODE_SURFACE_TEXT = "font-mono text-2xs leading-relaxed";

export function foldLines(text: string, limit = CODE_SURFACE_LINES): { shown: string; hidden: number; total: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { shown: text, hidden: 0, total: lines.length };
  return { shown: lines.slice(0, limit).join("\n"), hidden: lines.length - limit, total: lines.length };
}

const COPY_LABEL = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [state, setState] = useState<keyof typeof COPY_LABEL>("idle");
  const timer = useRef<number>(undefined);
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
  text: string;
  wrap?: boolean;
  fold?: boolean;
  tone?: "muted" | "foreground";
  className?: string;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = fold && !expanded ? foldLines(text) : { shown: text, hidden: 0, total: text.split("\n").length };
  return (
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
