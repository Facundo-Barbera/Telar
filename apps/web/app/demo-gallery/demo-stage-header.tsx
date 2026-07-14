"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon, LayoutGridIcon } from "lucide-react";

// Serializable slice of the neighbouring entries — the server passes plain
// strings so this client header can render the pager without touching Component.
export type StageNeighbor = { id: string; title: string } | null;

// Header strip above the rendered redesign: back-to-index, breadcrumb, title,
// concern badge, variant, summary, and a linear prev/next pager. j/k move
// prev/next (ignored while typing in a demo field) mirroring the /gallery pager.
export function DemoStageHeader({
  title,
  concern,
  summary,
  variant,
  position,
  total,
  prev,
  next,
}: {
  title: string;
  concern: string;
  summary: string;
  variant?: string;
  position: number;
  total: number;
  prev: StageNeighbor;
  next: StageNeighbor;
}) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      )
        return;
      if (e.key === "k" && prev) {
        e.preventDefault();
        router.push(`/demo-gallery/${prev.id}`);
      } else if (e.key === "j" && next) {
        e.preventDefault();
        router.push(`/demo-gallery/${next.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, router]);

  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href="/demo-gallery"
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LayoutGridIcon className="size-3" />
              Index
            </Link>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {concern}
            </span>
            <span className="truncate text-sm font-semibold">{title}</span>
            {variant && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-foreground/80">
                {variant}
              </span>
            )}
          </div>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">{summary}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1 text-xs">
          {prev ? (
            <Link
              href={`/demo-gallery/${prev.id}`}
              title={prev.title}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3" />
              Prev
            </Link>
          ) : (
            <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground/30">
              <ArrowLeftIcon className="size-3" />
              Prev
            </span>
          )}
          <span className="px-1 font-mono text-[10px] text-muted-foreground/60">
            {position}/{total}
          </span>
          {next ? (
            <Link
              href={`/demo-gallery/${next.id}`}
              title={next.title}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Next
              <ArrowRightIcon className="size-3" />
            </Link>
          ) : (
            <span className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground/30">
              Next
              <ArrowRightIcon className="size-3" />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
