"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from "lucide-react";
import type { CatalogItem } from "./gallery-groups";

// Compact per-entry header: section breadcrumb, entry title, position (n of N),
// a copy-view-id button (ids are how entries are referenced in docs/design-pass.md
// during the walkthrough), the linear prev/next pager over the WHOLE catalog, and
// keyboard navigation. Kept a client component so it can own clipboard + keyboard.
export function GalleryEntryHeader({
  items,
  currentId,
  viewHints,
}: {
  items: CatalogItem[];
  currentId: string;
  viewHints?: string[];
}) {
  const router = useRouter();
  const idx = items.findIndex((i) => i.id === currentId);
  const item = items[idx];
  const prev = idx > 0 ? items[idx - 1] : null;
  const next = idx >= 0 && idx < items.length - 1 ? items[idx + 1] : null;
  const [copied, setCopied] = useState(false);

  const copyId = useCallback(() => {
    void navigator.clipboard?.writeText(currentId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [currentId]);

  // ArrowLeft/ArrowRight and j/k move prev/next — never while focus is in an
  // input/textarea/select or a contenteditable (so typing in a demo composer or
  // the filter box is untouched). No modifier keys (Cmd+K owns the palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
      }
      if ((e.key === "ArrowLeft" || e.key === "j") && prev) {
        e.preventDefault();
        router.push(`/gallery/${prev.id}`);
      } else if ((e.key === "ArrowRight" || e.key === "k") && next) {
        e.preventDefault();
        router.push(`/gallery/${next.id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, router]);

  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {/* Breadcrumb: section › group */}
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
            <span>{item?.sectionLabel}</span>
            {item && item.groupLabel !== item.sectionLabel && (
              <>
                <ChevronRightIcon className="size-3" />
                <span>{item.groupLabel}</span>
              </>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{item?.label}</span>
            {item && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {item.badge}
              </span>
            )}
          </div>
          {item && <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1 text-xs">
          <button
            type="button"
            onClick={copyId}
            title="Copy view id"
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
            {currentId}
          </button>
          {prev ? (
            <Link
              href={`/gallery/${prev.id}`}
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
            {idx + 1}/{items.length}
          </span>
          {next ? (
            <Link
              href={`/gallery/${next.id}`}
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

      {viewHints && viewHints.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {viewHints.map((h) => (
            <span key={h} className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground/80">
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
